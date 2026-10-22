import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  authorizeDungeonqResponseAction,
  computeDungeonqResponseTargetRegistryDigest,
  DUNGEONQ_RESPONSE_ACTION_CATALOG,
  DUNGEONQ_RESPONSE_OBLIGATIONS,
  dungeonqResponseActionPolicyInputSchema,
  dungeonqResponseTargetRegistrySchema,
  evaluateDungeonqLegitimateHealth,
  verifyDungeonqResponseActionDecision,
  type DungeonqLegitimateHealthMeasurement,
  type DungeonqResponseActionRequest,
  type DungeonqResponseTargetKind,
  type DungeonqResponseTargetRegistry
} from "../../../packages/policy/src/dungeonq-response-action.ts";

import {
  fileOriginNarrowablePermissions,
  fileOriginResponseRoutes,
  type FileOriginResponseState
} from "./file-origin";

/*
 * DungeonQ A 級處置連接器 v1（DQ-HANDOFF-015 M5）。
 *
 * - 只執行通過 authorizeDungeonqResponseAction（purpose EXECUTE_A_CLASS）的決策；其他一律拒絕。
 * - 不只信任呼叫端的政策輸入：次數、全域每小時數、停止狀態與登錄表都用自己的處置紀錄核對。
 * - 每個動作：冪等鍵（決策摘要）、預期狀態比對、稽核鏈、生效讀回；結果不明先讀回，不重送。
 * - 健康讀回與自動回復依計畫 3.3：執行前讀回、執行、觀察後讀回、低於門檻自動回復並以最高優先升級；
 *   回復失敗即停止所有後續自動動作（已生效的 FENCE 保留），升級給人。
 * - 升級只呼叫注入的 escalate 介面；本模組不寄送任何通知。
 * 契約：docs/contracts/dungeonq-response-actions-v1.md。
 */

export const DUNGEONQ_RESPONSE_CONNECTOR_VERSION = "dungeonq-response-actions/v1";

export const dungeonqResponseConnectorLimits = Object.freeze({
  maxDecisionAgeMs: 30_000,
  maxDecisionFutureSkewMs: 5_000,
  preHealthWindowMs: 10_000,
  defaultObservationMs: 10_000,
  minObservationMs: 5_000,
  maxObservationMs: 120_000,
  defaultExecutorTimeoutMs: 5_000,
  minExecutorTimeoutMs: 100,
  maxExecutorTimeoutMs: 30_000,
  healthTimeoutMs: 5_000,
  escalationTimeoutMs: 5_000,
  maxAttempts: 10_000,
  maxAuditRows: 50_000,
  maxEscalations: 5_000
});

export type DungeonqResponseEscalationPriority = "CRITICAL" | "HIGH";
export type DungeonqResponseEscalation = {
  incidentId: string;
  priority: DungeonqResponseEscalationPriority;
  reason: string;
  actionCode: string | null;
  targetId: string | null;
  actionId: string | null;
  decisionDigest: string | null;
  at: string;
};
export type DungeonqResponseHealthSource = {
  /** 回傳 evaluateDungeonqLegitimateHealth 可直接判定的量測；current 只含 sinceMs 之後的樣本。 */
  measure(args: { sinceMs: number; signal: AbortSignal }): Promise<DungeonqLegitimateHealthMeasurement>;
};
export type DungeonqResponseTarget = { targetId: string; kind: DungeonqResponseTargetKind; assetId: string };
export type DungeonqResponseTargetContext = {
  incidentId: string;
  target: DungeonqResponseTarget;
  /** 登錄表中綁定本事件的被標記 context／來源（assetId），由登錄表決定，不由請求決定。 */
  flaggedSubjects: readonly string[];
  signal: AbortSignal;
};
export type DungeonqResponseExecutorContext = DungeonqResponseTargetContext & {
  actionId: string;
  parameters: { overlapSeconds: number | null; rateLimitDurationSeconds: number | null };
};
export type DungeonqResponseReceipt = Record<string, unknown>;
export type DungeonqResponseExecutor = {
  /** 讀取對象目前狀態，供預期狀態比對；對象格式不支援時丟出 definite 錯誤。 */
  readState(context: DungeonqResponseTargetContext): Promise<unknown>;
  /** 執行；必須以 actionId 冪等，並以 expectedState 在來源端做比對後設定。 */
  apply(context: DungeonqResponseExecutorContext, expectedState: unknown): Promise<DungeonqResponseReceipt>;
  /** 結果不明時以 actionId 讀回；確定沒有生效回 null。 */
  lookup(context: DungeonqResponseExecutorContext): Promise<DungeonqResponseReceipt | null>;
  verifyEffect(context: DungeonqResponseExecutorContext, receipt: DungeonqResponseReceipt, stage: "IMMEDIATE" | "OBSERVED"):
    Promise<{ confirmed: boolean; detail: string }>;
  /** 回復並讀回；null 表示不可回復（例如 FENCE）。 */
  rollback: ((context: DungeonqResponseExecutorContext, receipt: DungeonqResponseReceipt) => Promise<{ restored: boolean; detail: string }>) | null;
};
export type DungeonqResponseExecutorTable = Readonly<Record<string, DungeonqResponseExecutor>>;

/** definite=true 表示來源明確拒絕、沒有任何變更；false 表示結果不明，必須先讀回。 */
export class DungeonqResponseExecutorError extends Error {
  constructor(readonly code: string, readonly definite: boolean) {
    super(code);
    this.name = "DungeonqResponseExecutorError";
  }
}

export class DungeonqResponseConnectorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DungeonqResponseConnectorError";
  }
}

export type DungeonqResponseExecutionStatus =
  | "EXECUTED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "FAILED" | "UNKNOWN" | "REJECTED" | "SKIPPED";
export type DungeonqResponseReadback = "CONFIRMED" | "NOT_CONFIRMED" | "UNKNOWN";
export type DungeonqResponseExecutionResult = {
  status: DungeonqResponseExecutionStatus;
  reason: string;
  incidentId: string | null;
  actionId: string | null;
  actionCode: string | null;
  targetId: string | null;
  readback: DungeonqResponseReadback | null;
  replayed: boolean;
  escalation: DungeonqResponseEscalationPriority | null;
  healthBefore: string | null;
  healthAfter: string | null;
};
export type DungeonqResponseLedgerAction = {
  actionId: string;
  actionCode: string;
  targetId: string;
  assetId: string;
  status: "EXECUTED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "FAILED" | "UNKNOWN";
  readback: DungeonqResponseReadback;
  recordedAt: string;
  reason: string;
};
export type DungeonqResponseAuditRow = {
  seq: number; at: string; kind: string; incidentId: string | null; actionId: string | null;
  decisionDigest: string | null; detail: Record<string, unknown>; previous: string; hash: string;
};
export type DungeonqResponseConnectorOptions = {
  directory: string;
  /** 連接器自己的對象登錄表；請求中的登錄表必須與它的摘要相同。 */
  registry: () => DungeonqResponseTargetRegistry;
  executors: DungeonqResponseExecutorTable;
  health: DungeonqResponseHealthSource;
  escalate: (escalation: DungeonqResponseEscalation) => Promise<void>;
  clock?: (() => number) | undefined;
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  observationMs?: number | undefined;
  executorTimeoutMs?: number | undefined;
};
export type DungeonqResponseExecuteArgs = {
  decision: unknown;
  input: unknown;
  request: DungeonqResponseActionRequest;
  /** 呼叫端在判定前用 readTargetState 讀到的狀態；執行前會重新讀取比對。 */
  expectedState: unknown;
};
export type DungeonqResponseConnector = {
  execute(args: DungeonqResponseExecuteArgs): Promise<DungeonqResponseExecutionResult>;
  readTargetState(args: { incidentId: string; actionCode: string; targetId: string }): Promise<unknown>;
  policyInputState(args: { incidentId: string; evaluatedAt: string }): {
    incidentExecutions: Array<{ actionCode: string; targetId: string; assetId: string }>;
    globalAutomaticExecutionsLastHour: number;
    incidentAutomationHalted: boolean;
  };
  incidentStatus(incidentId: string): {
    incidentId: string; halted: boolean; changesFrozen: boolean; globalHalted: boolean; reason: string | null;
    actions: DungeonqResponseLedgerAction[];
  };
  /** M6 工單讀取的處置紀錄介面。 */
  responseLedger: { listIncidentActions(args: { incidentId: string; signal?: AbortSignal }): Promise<DungeonqResponseLedgerAction[]> };
  listAudit(args?: { incidentId?: string }): DungeonqResponseAuditRow[];
  close(): void;
};

const ledgerSchema = `
CREATE TABLE ledger_meta(id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL, global_halted INTEGER NOT NULL, halt_reason TEXT);
CREATE TABLE incidents(incident_id TEXT PRIMARY KEY, halted INTEGER NOT NULL, changes_frozen INTEGER NOT NULL, reason TEXT);
CREATE TABLE attempts(action_id TEXT PRIMARY KEY, decision_digest TEXT NOT NULL UNIQUE, incident_id TEXT NOT NULL, action_code TEXT NOT NULL, target_id TEXT NOT NULL, asset_id TEXT NOT NULL, attempted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL, readback TEXT NOT NULL, reason TEXT NOT NULL, receipt TEXT, policy_version TEXT NOT NULL, catalog_digest TEXT NOT NULL, registry_digest TEXT NOT NULL, input_digest TEXT NOT NULL);
CREATE TABLE audit(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, incident_id TEXT, action_id TEXT, decision_digest TEXT, detail TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE escalations(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, incident_id TEXT NOT NULL, priority TEXT NOT NULL, reason TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, delivered INTEGER NOT NULL, error TEXT);
CREATE INDEX attempts_incident ON attempts(incident_id);
CREATE INDEX attempts_time ON attempts(attempted_at);
`;

/** 連接器能履行的義務；決策中出現其他義務一律停止。 */
const handledObligations: ReadonlySet<string> = new Set([
  DUNGEONQ_RESPONSE_OBLIGATIONS.readbackHealthBefore,
  DUNGEONQ_RESPONSE_OBLIGATIONS.readbackHealthAfter,
  DUNGEONQ_RESPONSE_OBLIGATIONS.rollbackOnHealthFailure,
  DUNGEONQ_RESPONSE_OBLIGATIONS.escalateAfterRollback,
  DUNGEONQ_RESPONSE_OBLIGATIONS.freezeNewChanges
]);

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter(key => row[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
};
const fail = (code: string): never => {
  throw new DungeonqResponseConnectorError(code);
};
const check: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) fail(code);
};
const safeIdentifier = (value: unknown): string | null => typeof value === "string" && identifierPattern.test(value) ? value : null;
const errorCode = (error: unknown): string => {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code) ? code : "UNEXPECTED_ERROR";
};
const boundedInteger = (value: number | undefined, fallback: number, min: number, max: number, code: string): number => {
  const result = value ?? fallback;
  check(Number.isSafeInteger(result) && result >= min && result <= max, code);
  return result;
};

/** 每個外部呼叫都有逾時上限；逾時視為結果不明。 */
async function bounded<T>(timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DungeonqResponseExecutorError("EXECUTOR_TIMEOUT", false));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => {
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

type AttemptRow = {
  action_id: string; decision_digest: string; incident_id: string; action_code: string; target_id: string; asset_id: string;
  attempted_at: number; updated_at: number; status: string; readback: string; reason: string; receipt: string | null;
};
type IncidentRow = { incident_id: string; halted: number; changes_frozen: number; reason: string | null };

/** 開啟處置連接器。紀錄目錄必須是私人目錄（0700），同一時間只允許一個程序寫入。 */
export function openDungeonqResponseConnector(options: DungeonqResponseConnectorOptions): DungeonqResponseConnector {
  check(options && typeof options.registry === "function" && typeof options.escalate === "function"
    && options.health && typeof options.health.measure === "function"
    && options.executors && typeof options.executors === "object", "CONNECTOR_OPTIONS_INVALID");
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const limits = dungeonqResponseConnectorLimits;
  const observationMs = boundedInteger(options.observationMs, limits.defaultObservationMs, limits.minObservationMs,
    limits.maxObservationMs, "OBSERVATION_WINDOW_INVALID");
  const executorTimeoutMs = boundedInteger(options.executorTimeoutMs, limits.defaultExecutorTimeoutMs, limits.minExecutorTimeoutMs,
    limits.maxExecutorTimeoutMs, "EXECUTOR_TIMEOUT_INVALID");

  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const requested = resolve(options.directory);
  check(!lstatSync(requested).isSymbolicLink(), "LEDGER_STORAGE_INVALID");
  const directory = realpathSync(requested);
  const directoryInfo = lstatSync(directory);
  check(directoryInfo.isDirectory() && (directoryInfo.mode & 0o077) === 0, "LEDGER_STORAGE_NOT_PRIVATE");
  const lockPath = join(directory, "response-ledger.lock");
  const databasePath = join(directory, "response-ledger.sqlite");
  let lock: number;
  try {
    lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    return fail("LEDGER_STORAGE_LOCKED");
  }
  let db: DatabaseSync | undefined;
  let closed = false;
  // close() 會中止觀察等待，避免關閉後仍有計時器存活。
  const lifetime = new AbortController();
  const release = (): void => {
    db?.close();
    db = undefined;
    const own = fstatSync(lock);
    closeSync(lock);
    try {
      const current = lstatSync(lockPath);
      if (current.ino === own.ino && current.dev === own.dev) unlinkSync(lockPath);
    } catch { /* A replaced lock path is never unlinked. */ }
  };
  try {
    const existing = existsSync(databasePath);
    if (existing) {
      const info = lstatSync(databasePath);
      check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0, "LEDGER_STORAGE_INVALID");
    } else {
      closeSync(openSync(databasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    }
    db = new DatabaseSync(databasePath);
    const database = db;
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
    const all = <T>(sql: string, ...args: SQLInputValue[]): T[] => database.prepare(sql).all(...args) as unknown as T[];
    const one = <T>(sql: string, ...args: SQLInputValue[]): T | undefined => database.prepare(sql).get(...args) as T | undefined;
    const transact = <T>(run: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = run();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };
    if (!existing) {
      transact(() => {
        database.exec(ledgerSchema);
        database.prepare("INSERT INTO ledger_meta VALUES(1,?,0,NULL)").run(DUNGEONQ_RESPONSE_CONNECTOR_VERSION);
      });
    } else {
      check(one<{ quick_check: string }>("PRAGMA quick_check")?.quick_check === "ok", "LEDGER_STORAGE_CORRUPT");
      const expected = new DatabaseSync(":memory:");
      let expectedSchema: string;
      try {
        expected.exec(ledgerSchema);
        expectedSchema = JSON.stringify(expected.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all());
      } finally {
        expected.close();
      }
      check(JSON.stringify(database.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()) === expectedSchema,
        "LEDGER_SCHEMA_CHANGED");
      check(one<{ version: string }>("SELECT version FROM ledger_meta WHERE id=1")?.version === DUNGEONQ_RESPONSE_CONNECTOR_VERSION, "LEDGER_VERSION_CHANGED");
    }

    const count = (sql: string, ...args: SQLInputValue[]): number => one<{ n: number }>(sql, ...args)?.n ?? Number.MAX_SAFE_INTEGER;
    const appendAudit = (kind: string, fields: { incidentId?: string | null; actionId?: string | null; decisionDigest?: string | null;
      detail?: Record<string, unknown> }): void => {
      check(count("SELECT count(*) AS n FROM audit") < limits.maxAuditRows, "LEDGER_AUDIT_LIMIT");
      const previous = one<{ hash: string }>("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1")?.hash ?? "ROOT";
      const row = { at: clock(), kind, incidentId: fields.incidentId ?? null, actionId: fields.actionId ?? null,
        decisionDigest: fields.decisionDigest ?? null, detail: canonical(fields.detail ?? {}), previous };
      const hash = sha(`dungeonq-response-audit/v1\n${canonical(row)}`);
      database.prepare("INSERT INTO audit(at,kind,incident_id,action_id,decision_digest,detail,previous,hash) VALUES(?,?,?,?,?,?,?,?)")
        .run(row.at, kind, row.incidentId, row.actionId, row.decisionDigest, row.detail, previous, hash);
    };
    const globalHalt = (): { halted: boolean; reason: string | null } => {
      const row = one<{ global_halted: number; halt_reason: string | null }>("SELECT global_halted,halt_reason FROM ledger_meta WHERE id=1");
      check(row, "LEDGER_STATE_INVALID");
      return { halted: row.global_halted === 1, reason: row.halt_reason };
    };
    const incidentRow = (incidentId: string): IncidentRow =>
      one<IncidentRow>("SELECT * FROM incidents WHERE incident_id=?", incidentId)
        ?? { incident_id: incidentId, halted: 0, changes_frozen: 0, reason: null };
    const upsertIncident = (incidentId: string, change: { halted?: boolean; changesFrozen?: boolean; reason?: string }): void => {
      const row = incidentRow(incidentId);
      database.prepare("INSERT INTO incidents VALUES(?,?,?,?) ON CONFLICT(incident_id) DO UPDATE SET halted=excluded.halted,changes_frozen=excluded.changes_frozen,reason=excluded.reason")
        .run(incidentId, Number(change.halted ?? row.halted === 1), Number(change.changesFrozen ?? row.changes_frozen === 1), change.reason ?? row.reason);
    };
    /** 3.3 第 5 點：回復失敗或結果不明時停止所有後續自動動作（本事件與全域）。 */
    const haltAutomation = (incidentId: string, reason: string): void => {
      transact(() => {
        upsertIncident(incidentId, { halted: true, reason });
        database.prepare("UPDATE ledger_meta SET global_halted=1,halt_reason=coalesce(halt_reason,?) WHERE id=1").run(reason);
        appendAudit("AUTOMATION_HALTED", { incidentId, detail: { reason } });
      });
    };

    // Crash recovery: an attempt left PENDING may or may not have taken effect. Never resend; stop and hand to a human.
    for (const pending of all<AttemptRow>("SELECT * FROM attempts WHERE status='PENDING'")) {
      transact(() => {
        database.prepare("UPDATE attempts SET status='UNKNOWN',readback='UNKNOWN',reason=?,updated_at=? WHERE action_id=?")
          .run("connector_restarted_during_action", clock(), pending.action_id);
        appendAudit("ATTEMPT_UNKNOWN_AFTER_RESTART", { incidentId: pending.incident_id, actionId: pending.action_id, decisionDigest: pending.decision_digest });
      });
      haltAutomation(pending.incident_id, "connector_restarted_during_action");
    }

    const ledgerStatus = (status: string): DungeonqResponseLedgerAction["status"] =>
      (["EXECUTED", "ROLLED_BACK", "ROLLBACK_FAILED", "FAILED"].includes(status) ? status : "UNKNOWN") as DungeonqResponseLedgerAction["status"];
    const ledgerAction = (row: AttemptRow): DungeonqResponseLedgerAction => ({
      actionId: row.action_id, actionCode: row.action_code, targetId: row.target_id, assetId: row.asset_id,
      status: ledgerStatus(row.status),
      readback: (["CONFIRMED", "NOT_CONFIRMED"].includes(row.readback) ? row.readback : "UNKNOWN") as DungeonqResponseReadback,
      recordedAt: new Date(row.updated_at).toISOString(), reason: row.reason
    });
    const incidentAttempts = (incidentId: string): AttemptRow[] =>
      all<AttemptRow>("SELECT * FROM attempts WHERE incident_id=? ORDER BY attempted_at,rowid", incidentId);
    const windowMs = DUNGEONQ_RESPONSE_ACTION_CATALOG.global.windowSeconds * 1000;
    const globalCount = (atMs: number): number =>
      count("SELECT count(*) AS n FROM attempts WHERE attempted_at>? AND attempted_at<=?", atMs - windowMs, atMs);
    const halted = (incidentId: string): boolean => incidentRow(incidentId).halted === 1 || globalHalt().halted;

    const registryState = (): { registry: DungeonqResponseTargetRegistry; digest: string } => {
      const registry = dungeonqResponseTargetRegistrySchema.parse(options.registry());
      return { registry, digest: computeDungeonqResponseTargetRegistryDigest(registry) };
    };
    const flaggedSubjects = (registry: DungeonqResponseTargetRegistry, incidentId: string): string[] => registry.entries
      .filter(entry => entry.boundIncidentId === incidentId && (entry.kind === "FLAGGED_CONTEXT" || entry.kind === "FLAGGED_SOURCE"))
      .map(entry => entry.assetId);

    const escalateOnce = async (escalation: Omit<DungeonqResponseEscalation, "at">, dedupeKey: string): Promise<DungeonqResponseEscalationPriority> => {
      if (one("SELECT seq FROM escalations WHERE dedupe_key=?", dedupeKey)) return escalation.priority;
      const at = clock();
      const seq = transact(() => {
        check(count("SELECT count(*) AS n FROM escalations") < limits.maxEscalations, "LEDGER_ESCALATION_LIMIT");
        const inserted = Number(database.prepare("INSERT INTO escalations(at,incident_id,priority,reason,dedupe_key,delivered,error) VALUES(?,?,?,?,?,0,NULL)")
          .run(at, escalation.incidentId, escalation.priority, escalation.reason, dedupeKey).lastInsertRowid);
        appendAudit("ESCALATION_REQUESTED", { incidentId: escalation.incidentId, actionId: escalation.actionId, decisionDigest: escalation.decisionDigest,
          detail: { priority: escalation.priority, reason: escalation.reason } });
        return inserted;
      });
      // 單次呼叫、有逾時；失敗只記錄，不在這裡重送（重送與管道切換屬 M3 通知範圍）。
      try {
        await bounded(limits.escalationTimeoutMs, async () => options.escalate({ ...escalation, at: new Date(at).toISOString() }));
        database.prepare("UPDATE escalations SET delivered=1 WHERE seq=?").run(seq);
      } catch (error) {
        database.prepare("UPDATE escalations SET error=? WHERE seq=?").run(errorCode(error), seq);
      }
      return escalation.priority;
    };

    const readHealth = async (sinceMs: number): Promise<{ status: string; reason: string }> => {
      try {
        const measurement = await bounded(limits.healthTimeoutMs, signal => options.health.measure({ sinceMs, signal }));
        return evaluateDungeonqLegitimateHealth(measurement, new Date(clock()).toISOString());
      } catch {
        return { status: "UNKNOWN", reason: "health_read_failed" };
      }
    };

    const blank = (status: DungeonqResponseExecutionStatus, reason: string, fields: Partial<DungeonqResponseExecutionResult> = {}): DungeonqResponseExecutionResult => ({
      status, reason, incidentId: null, actionId: null, actionCode: null, targetId: null, readback: null, replayed: false,
      escalation: null, healthBefore: null, healthAfter: null, ...fields
    });

    const executeOnce = async (args: DungeonqResponseExecuteArgs): Promise<DungeonqResponseExecutionResult> => {
      check(!closed, "CONNECTOR_CLOSED");
      const request = args?.request;
      const requestIncident = safeIdentifier(request?.incidentId);
      if (!request || typeof request !== "object" || ![request.incidentId, request.actionCode, request.targetId].every(value => typeof value === "string")) {
        transact(() => appendAudit("REJECTED", { incidentId: requestIncident, detail: { reason: "request_invalid" } }));
        return blank("REJECTED", "request_invalid");
      }
      const authorization = authorizeDungeonqResponseAction({ decision: args?.decision, input: args?.input, request, purpose: "EXECUTE_A_CLASS" });
      if (!authorization.authorized) {
        const verification = verifyDungeonqResponseActionDecision({ decision: args?.decision, input: args?.input, request });
        const denied = verification.valid ? verification.decision : null;
        transact(() => appendAudit("REJECTED", { incidentId: denied?.incidentId ?? requestIncident, decisionDigest: denied?.decisionDigest ?? null,
          detail: { reason: authorization.reason, policyReason: denied?.reason ?? null } }));
        let escalation: DungeonqResponseEscalationPriority | null = null;
        // 已驗證、要求升級的拒絕決策（超過上限、已停止、合法使用者不健康）履行「升級給人」義務。
        if (denied && denied.incidentId !== null && denied.obligations.includes(DUNGEONQ_RESPONSE_OBLIGATIONS.escalateToHuman)) {
          escalation = await escalateOnce({ incidentId: denied.incidentId, priority: "HIGH", reason: `policy_denied:${denied.reason}`,
            actionCode: denied.actionCode, targetId: denied.target?.targetId ?? null, actionId: null, decisionDigest: denied.decisionDigest },
          `deny:${denied.decisionDigest}`);
        }
        return blank("REJECTED", authorization.reason, { incidentId: denied?.incidentId ?? requestIncident, escalation });
      }
      const decision = authorization.decision;
      const input = dungeonqResponseActionPolicyInputSchema.parse(args.input);
      const target = decision.target;
      const actionCode = decision.actionCode;
      const incidentId = decision.incidentId;
      check(target && actionCode && incidentId, "DECISION_INCOMPLETE");
      const actionId = `dqa-${decision.decisionDigest.slice(0, 40)}`;
      const base = { incidentId, actionId, actionCode, targetId: target.targetId };
      const reject = (reason: string, detail: Record<string, unknown> = {}): DungeonqResponseExecutionResult => {
        transact(() => appendAudit("REJECTED", { incidentId, actionId, decisionDigest: decision.decisionDigest, detail: { reason, ...detail } }));
        return blank("REJECTED", reason, base);
      };

      const unsupported = decision.obligations.find(obligation => !handledObligations.has(obligation));
      if (unsupported !== undefined) return reject("obligation_unsupported", { obligation: unsupported });

      // 重送：同一決策只執行一次；回傳既有紀錄，不再呼叫執行器。
      const prior = one<AttemptRow>("SELECT * FROM attempts WHERE decision_digest=?", decision.decisionDigest);
      if (prior) {
        transact(() => appendAudit("REPLAY_RETURNED", { incidentId, actionId: prior.action_id, decisionDigest: decision.decisionDigest }));
        const recorded = ledgerAction(prior);
        return blank(ledgerStatus(prior.status), prior.reason, { ...base, readback: recorded.readback, replayed: true });
      }

      const executor = Object.hasOwn(options.executors, actionCode) ? options.executors[actionCode] : undefined;
      if (!executor) return reject("executor_not_configured");

      // 以自己的紀錄核對政策輸入（M4：重新判定擋不住偽造輸入）。
      const now = clock();
      const evaluatedAtMs = Date.parse(input.evaluatedAt);
      if (!(now - evaluatedAtMs <= limits.maxDecisionAgeMs && evaluatedAtMs - now <= limits.maxDecisionFutureSkewMs)) {
        return reject("decision_stale");
      }
      const { registry, digest: registryDigest } = registryState();
      if (computeDungeonqResponseTargetRegistryDigest(input.targetRegistry) !== registryDigest || decision.registryDigest !== registryDigest) {
        return reject("target_registry_mismatch");
      }
      const recorded = incidentAttempts(incidentId).map(row => `${row.action_code}\n${row.target_id}\n${row.asset_id}`).sort();
      const claimed = input.incidentExecutions.map(row => `${row.actionCode}\n${row.targetId}\n${row.assetId}`).sort();
      if (canonical(recorded) !== canonical(claimed)) return reject("input_incident_executions_mismatch");
      if (input.globalAutomaticExecutionsLastHour !== globalCount(evaluatedAtMs)) return reject("input_global_count_mismatch");
      if (input.incidentAutomationHalted !== halted(incidentId)) return reject("input_halt_state_mismatch");
      if (halted(incidentId)) return reject("automation_halted");
      const freezes = decision.obligations.includes(DUNGEONQ_RESPONSE_OBLIGATIONS.freezeNewChanges);
      if (incidentRow(incidentId).changes_frozen === 1 && !freezes) return reject("incident_changes_frozen");

      const targetContext = (signal: AbortSignal): DungeonqResponseExecutorContext => ({
        incidentId, target, flaggedSubjects: flaggedSubjects(registry, incidentId), signal, actionId,
        parameters: { overlapSeconds: decision.parameters.overlapSeconds, rateLimitDurationSeconds: decision.parameters.rateLimitDurationSeconds }
      });

      // 3.3 第 1 點：執行前讀回合法消費者健康；不健康就不執行，升級給人。
      const before = await readHealth(now - limits.preHealthWindowMs);
      if (before.status !== "HEALTHY") {
        transact(() => appendAudit("SKIPPED_UNHEALTHY", { incidentId, actionId, decisionDigest: decision.decisionDigest, detail: before }));
        const escalation = await escalateOnce({ ...base, priority: "HIGH", reason: `legitimate_health_before_${before.status.toLowerCase()}:${before.reason}`,
          decisionDigest: decision.decisionDigest }, `skip:${decision.decisionDigest}`);
        return blank("SKIPPED", `legitimate_health_before_${before.status.toLowerCase()}`, { ...base, escalation, healthBefore: before.status });
      }

      // 預期狀態比對：不符就拒絕，不執行。
      let current: unknown;
      try {
        current = await bounded(executorTimeoutMs, signal => executor.readState(targetContext(signal)));
      } catch (error) {
        return reject("target_state_unreadable", { code: errorCode(error) });
      }
      if (canonical(current) !== canonical(args.expectedState)) return reject("expected_state_mismatch");

      // 先記錄嘗試（計入上限），再執行。
      transact(() => {
        check(count("SELECT count(*) AS n FROM attempts") < limits.maxAttempts, "LEDGER_ATTEMPT_LIMIT");
        database.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,'PENDING','UNKNOWN','executing',NULL,?,?,?,?)")
          .run(actionId, decision.decisionDigest, incidentId, actionCode, target.targetId, target.assetId, now, now,
            decision.policyVersion, decision.catalogDigest, registryDigest, decision.inputDigest ?? "");
        if (freezes) upsertIncident(incidentId, { changesFrozen: true });
        appendAudit("ATTEMPT_STARTED", { incidentId, actionId, decisionDigest: decision.decisionDigest,
          detail: { actionCode, targetId: target.targetId, assetId: target.assetId, policyVersion: decision.policyVersion,
            catalogDigest: decision.catalogDigest, registryDigest, inputDigest: decision.inputDigest, healthBefore: before.status } });
      });
      const finish = (status: Exclude<DungeonqResponseExecutionStatus, "REJECTED" | "SKIPPED">, readback: DungeonqResponseReadback, reason: string,
        receipt: DungeonqResponseReceipt | null): void => {
        transact(() => {
          database.prepare("UPDATE attempts SET status=?,readback=?,reason=?,receipt=?,updated_at=? WHERE action_id=?")
            .run(status, readback, reason, receipt === null ? null : canonical(receipt), clock(), actionId);
          appendAudit(`ATTEMPT_${status}`, { incidentId, actionId, decisionDigest: decision.decisionDigest, detail: { readback, reason } });
        });
      };

      // 從這裡起動作可能已生效：任何未預期的錯誤都記為結果不明並停止自動處置，不重送。
      const runAttempt = async (): Promise<DungeonqResponseExecutionResult> => {
        let receipt: DungeonqResponseReceipt | null | undefined;
        try {
          receipt = await bounded(executorTimeoutMs, signal => executor.apply(targetContext(signal), args.expectedState));
        } catch (error) {
          if (error instanceof DungeonqResponseExecutorError && error.definite) {
            const reason = `executor_rejected:${error.code}`;
            finish("FAILED", "NOT_CONFIRMED", reason, null);
            const escalation = await escalateOnce({ ...base, priority: "HIGH", reason, decisionDigest: decision.decisionDigest }, `failed:${actionId}`);
            return blank("FAILED", reason, { ...base, readback: "NOT_CONFIRMED", escalation, healthBefore: before.status });
          }
          // 結果不明：先讀回，不重送。
          try {
            receipt = await bounded(executorTimeoutMs, signal => executor.lookup(targetContext(signal)));
          } catch {
            receipt = undefined;
          }
          if (receipt === null) {
            const reason = `executor_not_applied:${errorCode(error)}`;
            finish("FAILED", "CONFIRMED", reason, null);
            const escalation = await escalateOnce({ ...base, priority: "HIGH", reason, decisionDigest: decision.decisionDigest }, `failed:${actionId}`);
            return blank("FAILED", reason, { ...base, readback: "CONFIRMED", escalation, healthBefore: before.status });
          }
          if (receipt === undefined) {
            const reason = `result_unknown:${errorCode(error)}`;
            finish("UNKNOWN", "UNKNOWN", reason, null);
            haltAutomation(incidentId, reason);
            const escalation = await escalateOnce({ ...base, priority: "CRITICAL", reason, decisionDigest: decision.decisionDigest }, `unknown:${actionId}`);
            return blank("UNKNOWN", reason, { ...base, readback: "UNKNOWN", escalation, healthBefore: before.status });
          }
        }
        const applied: DungeonqResponseReceipt = receipt;
        const appliedAt = clock();
        const verify = async (stage: "IMMEDIATE" | "OBSERVED"): Promise<{ confirmed: boolean; detail: string }> => {
          try {
            return await bounded(executorTimeoutMs, signal => executor.verifyEffect(targetContext(signal), applied, stage));
          } catch (error) {
            return { confirmed: false, detail: `readback_failed:${errorCode(error)}` };
          }
        };

        // 生效讀回 → 觀察時間 → 健康讀回（3.3 第 2、3 點）。
        const immediate = await verify("IMMEDIATE");
        let after: { status: string; reason: string } = { status: "NOT_EVALUATED", reason: "effect_not_confirmed" };
        let observed = immediate;
        if (immediate.confirmed) {
          await sleep(observationMs, lifetime.signal);
          check(!closed, "CONNECTOR_CLOSED");
          after = await readHealth(appliedAt);
          observed = await verify("OBSERVED");
        }
        if (immediate.confirmed && after.status === "HEALTHY" && observed.confirmed) {
          finish("EXECUTED", "CONFIRMED", "effect_confirmed_health_within_threshold", applied);
          return blank("EXECUTED", "effect_confirmed_health_within_threshold", { ...base, readback: "CONFIRMED", healthBefore: before.status,
            healthAfter: after.status });
        }

        // 3.3 第 4–6 點：自動回復、讀回確認恢復、最高優先升級；回復失敗即停止所有自動動作。
        const cause = !immediate.confirmed ? `effect_not_confirmed:${immediate.detail}`
          : after.status !== "HEALTHY" ? `legitimate_health_after_${after.status.toLowerCase()}:${after.reason}`
            : `effect_not_confirmed:${observed.detail}`;
        let restored = false;
        let rollbackDetail = "rollback_not_available";
        if (executor.rollback !== null) {
          const rollback = executor.rollback;
          try {
            const outcome = await bounded(executorTimeoutMs, signal => rollback(targetContext(signal), applied));
            restored = outcome.restored;
            rollbackDetail = outcome.detail;
          } catch (error) {
            rollbackDetail = `rollback_error:${errorCode(error)}`;
          }
        }
        let recovered: { status: string; reason: string } = { status: "NOT_EVALUATED", reason: rollbackDetail };
        if (restored) {
          const rolledBackAt = clock();
          await sleep(observationMs, lifetime.signal);
          check(!closed, "CONNECTOR_CLOSED");
          recovered = await readHealth(rolledBackAt);
        }
        if (restored && recovered.status === "HEALTHY") {
          const reason = `auto_rollback_completed:${cause}`;
          finish("ROLLED_BACK", "CONFIRMED", reason, applied);
          const escalation = await escalateOnce({ ...base, priority: "CRITICAL", reason, decisionDigest: decision.decisionDigest }, `rollback:${actionId}`);
          return blank("ROLLED_BACK", reason, { ...base, readback: "CONFIRMED", escalation, healthBefore: before.status, healthAfter: after.status });
        }
        const reason = restored ? `rollback_health_not_recovered:${cause}` : `rollback_failed:${rollbackDetail}:${cause}`;
        finish("ROLLBACK_FAILED", "NOT_CONFIRMED", reason, applied);
        haltAutomation(incidentId, reason);
        const escalation = await escalateOnce({ ...base, priority: "CRITICAL", reason, decisionDigest: decision.decisionDigest }, `rollback:${actionId}`);
        return blank("ROLLBACK_FAILED", reason, { ...base, readback: "NOT_CONFIRMED", escalation, healthBefore: before.status, healthAfter: after.status });
      };
      try {
        return await runAttempt();
      } catch (error) {
        try {
          const reason = `connector_error:${errorCode(error)}`;
          // 已寫入的最終狀態不覆寫；仍在 PENDING 的嘗試改記為結果不明。
          database.prepare("UPDATE attempts SET status='UNKNOWN',readback='UNKNOWN',reason=?,updated_at=? WHERE action_id=? AND status='PENDING'")
            .run(reason, clock(), actionId);
          haltAutomation(incidentId, reason);
        } catch { /* 紀錄本身不可用時，重啟後的 PENDING 復原會接手。 */ }
        throw error;
      }
    };

    // 一次只執行一個動作，確保次數核對與預期狀態比對不會互相競爭。
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
      const run = queue.then(task, task);
      queue = run.then(() => undefined, () => undefined);
      return run;
    };

    const connector: DungeonqResponseConnector = {
      execute: args => serialize(() => executeOnce(args)),
      async readTargetState({ incidentId, actionCode, targetId }) {
        check(!closed, "CONNECTOR_CLOSED");
        check(safeIdentifier(incidentId) && safeIdentifier(targetId) && typeof actionCode === "string", "TARGET_REQUEST_INVALID");
        const { registry } = registryState();
        const entry = registry.entries.find(candidate => candidate.targetId === targetId
          && (candidate.boundIncidentId === null || candidate.boundIncidentId === incidentId));
        check(entry, "TARGET_NOT_REGISTERED");
        const executor = Object.hasOwn(options.executors, actionCode) ? options.executors[actionCode] : undefined;
        check(executor, "EXECUTOR_NOT_CONFIGURED");
        return bounded(executorTimeoutMs, signal => executor.readState({ incidentId, signal, flaggedSubjects: flaggedSubjects(registry, incidentId),
          target: { targetId: entry.targetId, kind: entry.kind, assetId: entry.assetId } }));
      },
      policyInputState({ incidentId, evaluatedAt }) {
        check(!closed, "CONNECTOR_CLOSED");
        check(safeIdentifier(incidentId) && Number.isFinite(Date.parse(evaluatedAt)), "POLICY_STATE_REQUEST_INVALID");
        return {
          incidentExecutions: incidentAttempts(incidentId).map(row => ({ actionCode: row.action_code, targetId: row.target_id, assetId: row.asset_id })),
          globalAutomaticExecutionsLastHour: globalCount(Date.parse(evaluatedAt)),
          incidentAutomationHalted: halted(incidentId)
        };
      },
      incidentStatus(incidentId) {
        check(!closed, "CONNECTOR_CLOSED");
        check(safeIdentifier(incidentId), "INCIDENT_ID_INVALID");
        const row = incidentRow(incidentId);
        const global = globalHalt();
        return { incidentId, halted: row.halted === 1 || global.halted, changesFrozen: row.changes_frozen === 1, globalHalted: global.halted,
          reason: row.reason ?? global.reason, actions: incidentAttempts(incidentId).map(ledgerAction) };
      },
      responseLedger: {
        async listIncidentActions({ incidentId, signal }) {
          check(!closed, "CONNECTOR_CLOSED");
          check(!signal?.aborted, "LEDGER_READ_ABORTED");
          check(safeIdentifier(incidentId), "INCIDENT_ID_INVALID");
          return incidentAttempts(incidentId).map(ledgerAction);
        }
      },
      listAudit(args = {}) {
        check(!closed, "CONNECTOR_CLOSED");
        const rows = args.incidentId === undefined
          ? all<{ seq: number; at: number; kind: string; incident_id: string | null; action_id: string | null; decision_digest: string | null;
            detail: string; previous: string; hash: string }>("SELECT * FROM audit ORDER BY seq")
          : all<{ seq: number; at: number; kind: string; incident_id: string | null; action_id: string | null; decision_digest: string | null;
            detail: string; previous: string; hash: string }>("SELECT * FROM audit WHERE incident_id=? ORDER BY seq", args.incidentId);
        return rows.map(row => ({ seq: row.seq, at: new Date(row.at).toISOString(), kind: row.kind, incidentId: row.incident_id,
          actionId: row.action_id, decisionDigest: row.decision_digest, detail: JSON.parse(row.detail) as Record<string, unknown>,
          previous: row.previous, hash: row.hash }));
      },
      close() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        release();
      }
    };
    return connector;
  } catch (error) {
    release();
    if (error instanceof DungeonqResponseConnectorError) throw error;
    throw new DungeonqResponseConnectorError(errorCode(error) === "UNEXPECTED_ERROR" ? "LEDGER_UNAVAILABLE" : errorCode(error));
  }
}

/* ------------------------------------------------------------------ */
/* 執行器：A-1 作用在 DungeonQ 執行環境，其餘作用在受保護來源（FileOrigin） */
/* ------------------------------------------------------------------ */

export type DungeonqRuntimeFenceStore = {
  fence(input: { contextId: string; reason: string }): unknown;
  snapshot(): { contexts: Array<{ contextId: string; state: string; epoch: number; fenceReason?: string | null | undefined }> };
};
export type DungeonqFileOriginControl = {
  origin: string;
  controlToken: string;
  /** 本來源業務憑證在登錄表中的 assetId。 */
  credentialAssetId: string;
};

const definite = (code: string): never => {
  throw new DungeonqResponseExecutorError(code, true);
};
const flaggedSubjectPattern = /^(?:context|source):[A-Za-z0-9_-]{1,128}$/u;
const contextIdOf = (target: DungeonqResponseTarget): string =>
  /^context:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(target.assetId)?.[1] ?? definite("TARGET_ASSET_UNSUPPORTED");

/** A 級封鎖：以執行環境的 FENCE 封鎖被導入假世界的 context。FENCE 不可回復。 */
export function createRuntimeFenceExecutor(store: DungeonqRuntimeFenceStore): DungeonqResponseExecutor {
  const find = (contextId: string): { contextId: string; state: string; epoch: number; fenceReason?: string | null | undefined } | undefined =>
    store.snapshot().contexts.find(context => context.contextId === contextId);
  const fencedBy = (contextId: string, actionId: string): boolean => {
    const context = find(contextId);
    return context?.state === "FENCED" && typeof context.fenceReason === "string" && context.fenceReason.startsWith(`${actionId}: `);
  };
  const receiptOf = (contextId: string, actionId: string): DungeonqResponseReceipt => {
    const context = find(contextId);
    return { actionId, contextId, state: context?.state ?? "UNKNOWN", epoch: context?.epoch ?? null };
  };
  return {
    async readState(context) {
      const contextId = contextIdOf(context.target);
      const current = find(contextId) ?? definite("CONTEXT_UNKNOWN");
      return { contextId, state: current.state, epoch: current.epoch };
    },
    async apply(context, expectedState) {
      const contextId = contextIdOf(context.target);
      if (fencedBy(contextId, context.actionId)) return receiptOf(contextId, context.actionId);
      const current = find(contextId) ?? definite("CONTEXT_UNKNOWN");
      if (canonical({ contextId, state: current.state, epoch: current.epoch }) !== canonical(expectedState)) definite("STATE_CONFLICT");
      try {
        store.fence({ contextId, reason: `${context.actionId}: automatic fence for incident ${context.incidentId}` });
      } catch (error) {
        throw new DungeonqResponseExecutorError(errorCode(error), errorCode(error) !== "UNEXPECTED_ERROR");
      }
      return receiptOf(contextId, context.actionId);
    },
    async lookup(context) {
      const contextId = contextIdOf(context.target);
      return fencedBy(contextId, context.actionId) ? receiptOf(contextId, context.actionId) : null;
    },
    async verifyEffect(context) {
      const contextId = contextIdOf(context.target);
      return fencedBy(contextId, context.actionId)
        ? { confirmed: true, detail: "context_fenced" }
        : { confirmed: false, detail: "context_not_fenced" };
    },
    rollback: null
  };
}

function fileOriginCaller(control: DungeonqFileOriginControl) {
  check(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(control.origin) && /^[A-Za-z0-9_.-]{16,2048}$/u.test(control.controlToken)
    && identifierPattern.test(control.credentialAssetId), "FILE_ORIGIN_CONTROL_INVALID");
  const call = async (path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetch(`${control.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${control.controlToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal
      });
    } catch {
      throw new DungeonqResponseExecutorError("EXECUTOR_TRANSPORT_UNKNOWN", false);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new DungeonqResponseExecutorError("EXECUTOR_RESPONSE_UNKNOWN", false);
    }
    if (response.ok && parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    throw new DungeonqResponseExecutorError(typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code) ? code : `EXECUTOR_HTTP_${response.status}`,
      response.status >= 400 && response.status < 500);
  };
  const state = async (signal: AbortSignal): Promise<FileOriginResponseState> => {
    const value = await call("/control/response/state", undefined, signal) as unknown as FileOriginResponseState;
    if (value?.schemaVersion !== "dungeonq.file-origin-response-state/v1" || !Number.isSafeInteger(value.revision)) {
      throw new DungeonqResponseExecutorError("EXECUTOR_STATE_INVALID", false);
    }
    return value;
  };
  const expectedOf = (value: FileOriginResponseState): { revision: number; credentialEpoch: number; overlapState: string } =>
    ({ revision: value.revision, credentialEpoch: value.credential.epoch, overlapState: value.credential.overlap.state });
  const expectedRevision = (expected: unknown): number => {
    const revision = (expected as { revision?: unknown } | null)?.revision;
    return Number.isSafeInteger(revision) ? Number(revision) : definite("EXPECTED_STATE_INVALID");
  };
  const lookup = async (context: DungeonqResponseExecutorContext): Promise<DungeonqResponseReceipt | null> => {
    const value = await call("/control/response/receipt", { actionId: context.actionId }, context.signal);
    return value.found === true && value.receipt && typeof value.receipt === "object" ? value.receipt as DungeonqResponseReceipt : null;
  };
  return { call, state, expectedOf, expectedRevision, lookup };
}

/** A 級來源端動作：輪替（新舊並行）、更換路徑、收窄權限、限流。只作用在被標記對象與業務憑證。 */
function createFileOriginExecutors(control: DungeonqFileOriginControl): {
  rotateWithOverlap: DungeonqResponseExecutor; reroute: DungeonqResponseExecutor; narrow: DungeonqResponseExecutor; rateLimit: DungeonqResponseExecutor;
} {
  const origin = fileOriginCaller(control);
  type RuleSpec = { kind: "REROUTE" | "NARROW" | "RATE_LIMIT"; fields: Record<string, unknown> };
  const ruleExecutor = (spec: (context: DungeonqResponseTargetContext & { parameters?: DungeonqResponseExecutorContext["parameters"] }) => RuleSpec):
    DungeonqResponseExecutor => ({
    async readState(context) {
      spec(context);
      return origin.expectedOf(await origin.state(context.signal));
    },
    async apply(context, expected) {
      const { kind, fields } = spec(context);
      return origin.call("/control/response/apply", { actionId: context.actionId, kind, incidentId: context.incidentId,
        expectedRevision: origin.expectedRevision(expected), ...fields }, context.signal);
    },
    lookup: origin.lookup,
    async verifyEffect(context) {
      const rule = (await origin.state(context.signal)).rules.find(item => item.actionId === context.actionId);
      return { confirmed: rule?.state === "ACTIVE", detail: rule ? `rule_${rule.state.toLowerCase()}` : "rule_missing" };
    },
    async rollback(context) {
      const before = await origin.state(context.signal);
      await origin.call("/control/response/rollback", { rollbackId: `${context.actionId}-rb`, actionId: context.actionId,
        expectedRevision: before.revision }, context.signal);
      const rule = (await origin.state(context.signal)).rules.find(item => item.actionId === context.actionId);
      return { restored: rule?.state === "ROLLED_BACK", detail: rule ? `rule_${rule.state.toLowerCase()}` : "rule_missing" };
    }
  });
  const subjectsOf = (subjects: readonly string[]): string[] => {
    if (subjects.length === 0 || !subjects.every(subject => flaggedSubjectPattern.test(subject))) definite("FLAGGED_SUBJECTS_UNAVAILABLE");
    return [...subjects];
  };
  const reroute = ruleExecutor(context => {
    const route = /^route:([a-z-]{1,64})$/u.exec(context.target.assetId)?.[1];
    if (!route || !(fileOriginResponseRoutes as readonly string[]).includes(route)) definite("TARGET_ASSET_UNSUPPORTED");
    return { kind: "REROUTE", fields: { subjects: subjectsOf(context.flaggedSubjects), route } };
  });
  const narrow = ruleExecutor(context => {
    const match = /^grant:(context|source):([A-Za-z0-9_-]{1,128}):([A-Za-z]{1,64})$/u.exec(context.target.assetId);
    if (!match || !(fileOriginNarrowablePermissions as readonly string[]).includes(match[3] ?? "")) definite("TARGET_ASSET_UNSUPPORTED");
    return { kind: "NARROW", fields: { subjects: [`${match?.[1]}:${match?.[2]}`], permission: match?.[3] } };
  });
  const rateLimit = ruleExecutor(context => {
    if (!flaggedSubjectPattern.test(context.target.assetId)) definite("TARGET_ASSET_UNSUPPORTED");
    const duration = context.parameters?.rateLimitDurationSeconds;
    return { kind: "RATE_LIMIT", fields: { subjects: [context.target.assetId], ...(duration === undefined ? {} : { durationSeconds: duration }) } };
  });
  const credentialTarget = (context: DungeonqResponseTargetContext): void => {
    if (context.target.assetId !== control.credentialAssetId) definite("TARGET_ASSET_UNSUPPORTED");
  };
  const rotateWithOverlap: DungeonqResponseExecutor = {
    async readState(context) {
      credentialTarget(context);
      return origin.expectedOf(await origin.state(context.signal));
    },
    async apply(context, expected) {
      credentialTarget(context);
      const epoch = (expected as { credentialEpoch?: unknown } | null)?.credentialEpoch;
      if (!Number.isSafeInteger(epoch) || context.parameters.overlapSeconds === null) definite("EXPECTED_STATE_INVALID");
      // 來源在同一個交易內產生新憑證、為每個登錄的合法消費者封存一份，並開始過渡期。
      return origin.call("/control/response/apply", { actionId: context.actionId, kind: "ROTATE_OVERLAP", incidentId: context.incidentId,
        expectedRevision: origin.expectedRevision(expected), expectedEpoch: epoch, overlapSeconds: context.parameters.overlapSeconds }, context.signal);
    },
    lookup: origin.lookup,
    async verifyEffect(context, receipt, stage) {
      const value = await origin.state(context.signal);
      const epochMatches = value.credential.epoch === receipt.epoch;
      if (stage === "IMMEDIATE") {
        const delivered = value.credential.consumers.every(consumer => consumer.deliveredEpoch === receipt.epoch);
        const confirmed = epochMatches && value.credential.overlap.state === "OVERLAP" && delivered;
        return { confirmed, detail: confirmed ? "rotated_overlap_delivered" : `rotation_state:${value.credential.overlap.state}:delivered_${String(delivered)}` };
      }
      const switched = value.credential.consumers.filter(consumer => consumer.firstSuccessAt !== null).length;
      const confirmed = epochMatches && switched === value.credential.consumers.length;
      return { confirmed, detail: `consumers_on_new_credential:${switched}/${value.credential.consumers.length}` };
    },
    async rollback(context) {
      // 回復只延長「綁定的合法消費者可用舊憑證」；新憑證保留，過渡期已結束的舊憑證不會恢復。
      const before = await origin.state(context.signal);
      try {
        await origin.call("/control/response/rollback", { rollbackId: `${context.actionId}-rb`, actionId: context.actionId,
          expectedRevision: before.revision }, context.signal);
      } catch (error) {
        if (error instanceof DungeonqResponseExecutorError && error.definite) return { restored: false, detail: `rollback_refused:${error.code}` };
        throw error;
      }
      const after = await origin.state(context.signal);
      return { restored: after.credential.overlap.state === "HELD", detail: `overlap_${after.credential.overlap.state.toLowerCase()}` };
    }
  };
  return { rotateWithOverlap, reroute, narrow, rateLimit };
}

/** 執行器對照表：動作代號只在這裡當物件鍵出現；選哪個動作與對象由政策決策決定。 */
export function createDungeonqResponseExecutors(options: {
  runtimeFence: DungeonqRuntimeFenceStore;
  fileOrigin: DungeonqFileOriginControl;
}): DungeonqResponseExecutorTable {
  const origin = createFileOriginExecutors(options.fileOrigin);
  return Object.freeze({
    "A-1": createRuntimeFenceExecutor(options.runtimeFence),
    "A-2": origin.rotateWithOverlap,
    "A-3": origin.reroute,
    "A-4": origin.narrow,
    "A-5": origin.rateLimit
  });
}
