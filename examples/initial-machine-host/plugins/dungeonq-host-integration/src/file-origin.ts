import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, unlinkSync
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  dungeonqLogicalTargetId, dungeonqMaximumTargetBytes, dungeonqPursuitTargetRelativePath, dungeonqTargetRelativePath,
  targetWitnessSchema, type TargetWitness
} from "./contracts";
import { DungeonQHostError } from "./target-witness";

const schema = `
CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, revision INTEGER NOT NULL, failure TEXT);
CREATE TABLE records(key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE tickets(id TEXT PRIMARY KEY, scope TEXT NOT NULL, expires INTEGER NOT NULL, maximum INTEGER NOT NULL, uses INTEGER NOT NULL);
CREATE TABLE requests(id TEXT PRIMARY KEY, digest TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL, response TEXT, error TEXT);
CREATE TABLE admissions(seq INTEGER PRIMARY KEY, context TEXT NOT NULL, accepted INTEGER NOT NULL, request_id TEXT NOT NULL);
CREATE TABLE access_intents(seq INTEGER PRIMARY KEY, admission_seq INTEGER, purpose TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, bytes_read INTEGER, digest TEXT, error TEXT);
`;
const rotationSchema = `
CREATE TABLE credential_state(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, token_hash TEXT NOT NULL);
CREATE TABLE credential_receipts(action_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, next_hash TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL);
CREATE TABLE request_epochs(request_id TEXT PRIMARY KEY REFERENCES requests(id), epoch INTEGER NOT NULL);
`;
/*
 * Response mode (DQ-HANDOFF-015 M5, docs/contracts/dungeonq-response-actions-v1.md):
 * A-class response actions that change only flagged callers and the business credential.
 * - Registered legitimate consumers prove a separate binding header; they are never subject to
 *   flagged-subject rules and their permission set is never narrowed.
 * - Credential rotation keeps the superseded credential valid for bound consumers only during
 *   the overlap; unbound callers presenting it are rejected. A revoked credential is never restored.
 * - Route diversion, permission narrowing and rate limits apply only to flagged subjects.
 * Response mode is opt-in, requires rotation mode and uses its own schema; other modes are unchanged.
 */
const responseSchema = `
CREATE TABLE response_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, previous_hash TEXT, previous_epoch INTEGER, overlap_ends INTEGER, overlap_state TEXT NOT NULL);
CREATE TABLE response_actions(action_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, kind TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE response_rules(action_id TEXT PRIMARY KEY, kind TEXT NOT NULL, incident_id TEXT NOT NULL, subjects TEXT NOT NULL, route TEXT, permission TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, state TEXT NOT NULL);
CREATE TABLE consumer_deliveries(consumer_id TEXT NOT NULL, epoch INTEGER NOT NULL, sealed TEXT NOT NULL, fetched_at INTEGER, first_success_at INTEGER, PRIMARY KEY(consumer_id, epoch));
`;
export const fileOriginResponseLimits = Object.freeze({
  maxConsumers: 8, minOverlapSeconds: 1, maxOverlapSeconds: 900, maxRateLimitSeconds: 86_400,
  rateLimitWindowMs: 10_000, rateLimitMaxRequests: 1, maxRules: 256, maxSubjectsPerRule: 32, maxActions: 2048
});
export const fileOriginResponseRoutes = Object.freeze(["business-read", "business-ticket", "business-write", "business-overview"] as const);
export const fileOriginNarrowablePermissions = Object.freeze(["readTarget", "readOtherRecords", "writeOtherRecords", "issueTickets"] as const);
export const fileOriginConsumerBindingHeader = "x-dungeonq-consumer-binding";
export const fileOriginCredentialEpochHeader = "x-dungeonq-credential-epoch";
export type FileOriginResponseRoute = typeof fileOriginResponseRoutes[number];
export type FileOriginNarrowablePermission = typeof fileOriginNarrowablePermissions[number];
export type FileOriginResponseProfile = {
  /** Registered legitimate consumers of the business credential (1-8). */
  consumers: Array<{ consumerId: string; bindingToken: string }>;
  /** Synthetic decoy bytes (canonical base64) served to diverted target reads; never the real target. */
  divertedContentsBase64: string;
  /** Time source for overlap, rule expiry and rate windows; defaults to Date.now. */
  clock?: (() => number) | undefined;
};
export type FileOriginResponseRule = {
  actionId: string; kind: "REROUTE" | "NARROW" | "RATE_LIMIT"; incidentId: string; subjects: string[];
  route: string | null; permission: string | null; createdAt: number; expiresAt: number | null;
  state: "ACTIVE" | "ROLLED_BACK" | "EXPIRED";
};
export type FileOriginResponseState = {
  schemaVersion: "dungeonq.file-origin-response-state/v1"; revision: number;
  credential: {
    epoch: number;
    overlap: { state: "NONE" | "OVERLAP" | "HELD" | "EXPIRED" | "REVOKED"; previousEpoch: number | null; endsAt: number | null };
    consumers: Array<{ consumerId: string; deliveredEpoch: number | null; fetchedAt: number | null; firstSuccessAt: number | null }>;
  };
  rules: FileOriginResponseRule[];
};
export type FileOriginRotationReceipt = { actionId: string; at: string; previousEpoch: number; epoch: number; monotonicNs: string };
const targetKey = dungeonqLogicalTargetId;
const maximumEntries = 20_000;
const effectfulRequestLimit = 2048;
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
};
const jsonDigest = (value: unknown): string => sha(canonical(value));
const check: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw new DungeonQHostError(code);
};
const errorCode = (error: unknown): string => error instanceof DungeonQHostError ? error.code : "FILE_ORIGIN_UNAVAILABLE";
const tokenEqual = (value: unknown, expected: string): boolean => typeof value === "string" && value.length <= 2048
  && timingSafeEqual(Buffer.from(sha(value)), Buffer.from(sha(expected)));
const bearer = (request: IncomingMessage): string | undefined => /^Bearer ([A-Za-z0-9_.-]{1,2048})$/u.exec(request.headers.authorization ?? "")?.[1];
const safeLabel = (value: unknown, fallback: string): string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : fallback;

type JsonRecord = Record<string, unknown>;
type PassiveContracts = {
  runtimeJson(value: unknown, maxBytes?: number, maxDepth?: number): unknown;
  runtimeEnvelope(value: unknown, required: string[], optional?: string[], maxBytes?: number): void;
  runtimeId(value: unknown, code?: string): string;
  runtimeValue(value: unknown, maxBytes: number): unknown;
};
type Admission = { seq: number; context: string; accepted: number; request_id: string };
export type FileOriginAccessIntent = {
  seq: number; admission_seq: number | null; purpose: "STARTUP" | "WITNESS" | "GUARD" | "BUSINESS";
  request_id: string; state: "PENDING" | "VERIFIED" | "READ" | "FAILED";
  bytes_read: number | null; digest: string | null; error: string | null;
};
export type FileOriginReport = {
  schemaVersion: "dungeonq.origin-witness/v1"; resource: "initial-machine-artificial-file";
  stateDigest: string; configDigest: string; accepted: number; rejected: number;
  acceptedContexts: string[]; highWater: number; admissions: Admission[];
  targetReads: FileOriginAccessIntent[]; accessIntents: FileOriginAccessIntent[];
  credentialEpoch?: number;
  targetReadCount: number; witnessReadCount: number; revision: number; complete: true;
};
export type FileOriginOptions = {
  targetPath: string; baseline: TargetWitness; directory: string; normalToken: string;
  witnessToken: string; rotationControlToken?: string | undefined; host?: string; port?: number;
  accessPolicy?: FileOriginAccessPolicy;
  responseProfile?: FileOriginResponseProfile | undefined;
};
export type FileOriginAccessPolicy = {
  tenantId: string; principalId: string; readTarget: boolean; readOtherRecords: boolean;
  writeOtherRecords: boolean; issueTickets: boolean;
};
export type FileOrigin = { origin: string; report(): FileOriginReport; close(): Promise<void> };
type RequestRow = { id: string; digest: string; operation: string; state: string; response: string | null; error: string | null };
type Ticket = { id: string; scope: string; expires: number; maximum: number; uses: number };
type RecordRow = { key: string; value: string; revision: number };

/** A separate host connector: the real target never enters DungeonQ's canonical world. */
async function openFileOrigin(options: FileOriginOptions): Promise<FileOrigin> {
  const baseline = targetWitnessSchema.parse(options.baseline);
  // The business bearer is bound to one source-owned principal. Missing policy is
  // deliberately unable to read the protected target.
  const policy: FileOriginAccessPolicy = options.accessPolicy ?? {
    tenantId: "reference", principalId: "ordinary-connector", readTarget: false,
    readOtherRecords: true, writeOtherRecords: true, issueTickets: true
  };
  check(Object.keys(policy).sort().join(",") === ["tenantId", "principalId", "readTarget", "readOtherRecords", "writeOtherRecords", "issueTickets"].sort().join(",")
    && /^[A-Za-z0-9_-]{1,128}$/u.test(policy.tenantId)
    && /^[A-Za-z0-9_-]{1,128}$/u.test(policy.principalId)
    && [policy.readTarget, policy.readOtherRecords, policy.writeOtherRecords, policy.issueTickets].every(value => typeof value === "boolean"),
  "ORIGIN_POLICY_INVALID");
  check((baseline.mode & 0o077) === 0, "TARGET_PRIVATE_MODE_REQUIRED");
  check([options.normalToken, options.witnessToken].every(value => /^[A-Za-z0-9_.-]{16,2048}$/u.test(value))
    && options.normalToken !== options.witnessToken, "ORIGIN_CREDENTIAL_INVALID");
  const rotating = options.rotationControlToken !== undefined;
  check(!rotating || /^[A-Za-z0-9_.-]{16,2048}$/u.test(options.rotationControlToken!)
    && ![options.normalToken, options.witnessToken].includes(options.rotationControlToken!), "ORIGIN_CREDENTIAL_INVALID");
  const profile = options.responseProfile;
  const responding = profile !== undefined;
  check(!responding || rotating, "ORIGIN_RESPONSE_REQUIRES_ROTATION");
  type Consumer = { consumerId: string; bindingToken: string; bindingHash: string };
  const consumers: Consumer[] = [];
  let divertedContents = "";
  if (profile) {
    check(profile && typeof profile === "object" && Object.keys(profile).every(key => ["consumers", "divertedContentsBase64", "clock"].includes(key))
      && Array.isArray(profile.consumers) && profile.consumers.length >= 1 && profile.consumers.length <= fileOriginResponseLimits.maxConsumers
      && (profile.clock === undefined || typeof profile.clock === "function"), "ORIGIN_RESPONSE_PROFILE_INVALID");
    const reserved = new Set([options.normalToken, options.witnessToken, options.rotationControlToken!].map(token => sha(token)));
    for (const entry of profile.consumers) {
      check(entry && typeof entry === "object" && Object.keys(entry).sort().join(",") === "bindingToken,consumerId"
        && typeof entry.consumerId === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(entry.consumerId)
        && typeof entry.bindingToken === "string" && /^[A-Za-z0-9_.-]{32,2048}$/u.test(entry.bindingToken), "ORIGIN_RESPONSE_PROFILE_INVALID");
      const bindingHash = sha(entry.bindingToken);
      check(!reserved.has(bindingHash) && !consumers.some(row => row.consumerId === entry.consumerId), "ORIGIN_RESPONSE_PROFILE_INVALID");
      reserved.add(bindingHash);
      consumers.push({ consumerId: entry.consumerId, bindingToken: entry.bindingToken, bindingHash });
    }
    const decoy = profile.divertedContentsBase64;
    check(typeof decoy === "string" && decoy.length >= 4 && decoy.length <= 4096
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(decoy)
      && Buffer.from(decoy, "base64").toString("base64") === decoy
      && sha(Buffer.from(decoy, "base64")) !== baseline.sha256, "ORIGIN_RESPONSE_PROFILE_INVALID");
    divertedContents = decoy;
  }
  const clock = profile?.clock ?? Date.now;
  const activeSchema = schema + (rotating ? rotationSchema : "") + (responding ? responseSchema : "");
  const host = options.host ?? "127.0.0.1";
  check(host === "127.0.0.1", "ORIGIN_LOOPBACK_REQUIRED");
  check(options.port === undefined || Number.isSafeInteger(options.port) && options.port >= 0 && options.port <= 65535, "ORIGIN_PORT_INVALID");
  const requestedTarget = resolve(options.targetPath);
  const relativeTarget = [dungeonqTargetRelativePath, dungeonqPursuitTargetRelativePath]
    .find(path => requestedTarget.endsWith(`${sep}${path.split("/").join(sep)}`));
  check(relativeTarget, "HOST_PATH_NOT_ALLOWLISTED");
  const suffix = `${sep}${relativeTarget.split("/").join(sep)}`;
  const root = realpathSync(requestedTarget.slice(0, -suffix.length));
  const target = join(root, relativeTarget);
  const assertTargetSegments = (): void => {
    let cursor = root;
    for (const segment of relativeTarget.split("/").slice(0, -1)) {
      cursor = join(cursor, segment);
      const info = lstatSync(cursor);
      check(info.isDirectory() && !info.isSymbolicLink(), "HOST_SYMLINK_DENIED");
    }
  };
  assertTargetSegments();
  // Only passive public validation is shared. No target bytes are passed to a world/store API.
  const passive = await import(new URL("../../../vendor/dungeonq-runtime/runtime/contracts.mjs", import.meta.url).href) as PassiveContracts;
  const validate = (run: () => void): void => {
    try { run(); } catch (error) {
      if (error instanceof DungeonQHostError) throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      throw new DungeonQHostError(typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/u.test(code) ? code : "INVALID_ENVELOPE");
    }
  };
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const requestedDirectory = resolve(options.directory);
  check(!lstatSync(requestedDirectory).isSymbolicLink(), "ORIGIN_STORAGE_INVALID");
  const directory = realpathSync(requestedDirectory);
  check(directory !== dirname(target) && !target.startsWith(`${directory}${sep}`), "ORIGIN_STORAGE_OVERLAPS_TARGET");
  const directoryInfo = lstatSync(directory, { bigint: true });
  check(directoryInfo.isDirectory() && (Number(directoryInfo.mode) & 0o077) === 0, "ORIGIN_STORAGE_NOT_PRIVATE");
  const databasePath = join(directory, "file-origin.sqlite");
  const lockPath = join(directory, "file-origin.lock");
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new DungeonQHostError("ORIGIN_STORAGE_LOCKED"); }
  let db: DatabaseSync | undefined;
  let targetFd: number | undefined;
  let closed = false;
  const release = (): void => {
    if (targetFd !== undefined) { closeSync(targetFd); targetFd = undefined; }
    db?.close(); db = undefined;
    const ownLock = fstatSync(lock, { bigint: true });
    closeSync(lock);
    try {
      const current = lstatSync(lockPath, { bigint: true });
      if (current.ino === ownLock.ino && current.dev === ownLock.dev) unlinkSync(lockPath);
    } catch { /* A replaced storage path is never unlinked. */ }
  };
  try {
    const existing = existsSync(databasePath);
    if (existing) {
      const info = lstatSync(databasePath);
      check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.mode & 0o077) && info.size > 0, "ORIGIN_STORAGE_INVALID");
    } else {
      closeSync(openSync(databasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    }
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      if (!existsSync(databasePath + sidecar)) continue;
      const info = lstatSync(databasePath + sidecar);
      check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.mode & 0o077), "ORIGIN_STORAGE_INVALID");
    }
    db = new DatabaseSync(databasePath);
    const database = db;
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
    const storageInfo = lstatSync(databasePath, { bigint: true });
    const ownLockInfo = fstatSync(lock, { bigint: true });
    const all = <T>(sql: string, ...args: SQLInputValue[]): T[] => database.prepare(sql).all(...args) as unknown as T[];
    const one = <T>(sql: string, ...args: SQLInputValue[]): T | undefined => database.prepare(sql).get(...args) as T | undefined;
    const transact = <T>(run: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try { const result = run(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    };
    const configDigest = jsonDigest({ schemaVersion: "initial-machine.file-origin/v1", target,
      baseline: { sha256: baseline.sha256, sizeBytes: baseline.sizeBytes, mode: baseline.mode,
        device: baseline.device, inode: baseline.inode, modifiedAtMs: baseline.modifiedAtMs },
      normalTokenHash: sha(options.normalToken), witnessTokenHash: sha(options.witnessToken), contextId: "ordinary", policy,
      ...(rotating ? { rotationControlTokenHash: sha(options.rotationControlToken!), rotationSchemaVersion: 1 } : {}),
      ...(responding ? { responseProfile: { schemaVersion: 1, consumers: consumers.map(({ consumerId, bindingHash }) => ({ consumerId, bindingHash })),
        divertedDigest: sha(divertedContents) } } : {}) });
    if (!existing) {
      transact(() => {
        database.exec(activeSchema);
        database.prepare("INSERT INTO meta VALUES(1,?,1,NULL)").run(configDigest);
        if (rotating) database.prepare("INSERT INTO credential_state VALUES(1,0,?)").run(sha(options.normalToken));
        if (responding) database.prepare("INSERT INTO response_state VALUES(1,0,NULL,NULL,NULL,'NONE')").run();
      });
    } else {
      check(one<{ quick_check: string }>("PRAGMA quick_check")?.quick_check === "ok", "ORIGIN_STORAGE_CORRUPT");
      const expected = new DatabaseSync(":memory:");
      let expectedSchema: string;
      try { expected.exec(activeSchema); expectedSchema = JSON.stringify(expected.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()); }
      finally { expected.close(); }
      check(JSON.stringify(database.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()) === expectedSchema, "ORIGIN_SCHEMA_CHANGED");
      check(one<{ config: string }>("SELECT config FROM meta WHERE id=1")?.config === configDigest, "ORIGIN_CONFIG_CHANGED");
    }
    const credential = (): { epoch: number; token_hash: string } => {
      const row = rotating ? one<{ epoch: number; token_hash: string }>("SELECT epoch,token_hash FROM credential_state WHERE id=1")
        : { epoch: 0, token_hash: sha(options.normalToken) };
      check(row && Number.isSafeInteger(row.epoch) && row.epoch >= 0 && /^[a-f0-9]{64}$/u.test(row.token_hash), "ORIGIN_CREDENTIAL_STATE_INVALID");
      return row;
    };
    const assertStorage = (): void => {
      check(!closed, "ORIGIN_CLOSED");
      const actualDirectory = lstatSync(directory, { bigint: true });
      const actualDatabase = lstatSync(databasePath, { bigint: true });
      const actualLock = lstatSync(lockPath, { bigint: true });
      check(actualDirectory.isDirectory() && actualDirectory.ino === directoryInfo.ino && actualDirectory.dev === directoryInfo.dev
        && !(Number(actualDirectory.mode) & 0o077), "ORIGIN_STORAGE_CHANGED");
      check(actualDatabase.isFile() && actualDatabase.ino === storageInfo.ino && actualDatabase.dev === storageInfo.dev
        && actualDatabase.nlink === 1n && !(Number(actualDatabase.mode) & 0o077), "ORIGIN_STORAGE_CHANGED");
      check(actualLock.isFile() && actualLock.ino === ownLockInfo.ino && actualLock.dev === ownLockInfo.dev && actualLock.nlink === 1n,
        "ORIGIN_STORAGE_CHANGED");
    };
    const meta = (): { revision: number; failure: string | null } => {
      const result = one<{ revision: number; failure: string | null }>("SELECT revision,failure FROM meta WHERE id=1");
      check(result, "ORIGIN_AUDIT_INCOMPLETE"); return result;
    };
    const assertHealthy = (): void => {
      assertStorage();
      credential();
      check(meta().failure === null, "ORIGIN_WITNESS_UNAVAILABLE");
      check(one<{ n: number }>("SELECT count(*) AS n FROM access_intents WHERE state IN ('PENDING','FAILED')")?.n === 0
        && one<{ n: number }>("SELECT count(*) AS n FROM requests WHERE state!='DONE'")?.n === 0, "ORIGIN_AUDIT_INCOMPLETE");
      for (const table of ["admissions", "access_intents"] as const) {
        const census = one<{ total: number; high: number; low: number }>(`SELECT count(*) AS total,coalesce(max(seq),0) AS high,coalesce(min(seq),1) AS low FROM ${table}`);
        check(census && census.total === census.high && census.low === 1, "ORIGIN_AUDIT_INCOMPLETE");
      }
      check(one<{ n: number }>("SELECT count(*) AS n FROM access_intents i LEFT JOIN admissions a ON a.seq=i.admission_seq WHERE i.admission_seq IS NOT NULL AND (a.seq IS NULL OR a.accepted!=1)")?.n === 0,
        "ORIGIN_AUDIT_INCOMPLETE");
    };
    const capacity = (table: "admissions" | "access_intents" | "requests" | "tickets" | "records", limit = maximumEntries): void => {
      check((one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? limit) < limit, "ORIGIN_AUDIT_LIMIT");
    };
    type ResponseRow = { revision: number; previous_hash: string | null; previous_epoch: number | null; overlap_ends: number | null; overlap_state: string };
    type RuleRow = { action_id: string; kind: string; incident_id: string; subjects: string; route: string | null; permission: string | null;
      created_at: number; expires_at: number | null; state: string };
    const hashEqual = (left: string, right: string): boolean => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
    const responseRow = (): ResponseRow => {
      const row = one<ResponseRow>("SELECT revision,previous_hash,previous_epoch,overlap_ends,overlap_state FROM response_state WHERE id=1");
      check(row && Number.isSafeInteger(row.revision) && row.revision >= 0 && ["NONE", "OVERLAP", "HELD", "REVOKED"].includes(row.overlap_state),
        "ORIGIN_RESPONSE_STATE_INVALID");
      return row;
    };
    /** Overlap expiry is evaluated lazily from the clock; no timer or background loop exists. */
    const overlapView = (row: ResponseRow = responseRow()): { state: FileOriginResponseState["credential"]["overlap"]["state"]; accepting: boolean } => {
      const state = (row.overlap_state === "OVERLAP" && row.overlap_ends !== null && clock() >= row.overlap_ends ? "EXPIRED" : row.overlap_state) as
        FileOriginResponseState["credential"]["overlap"]["state"];
      return { state, accepting: state === "OVERLAP" || state === "HELD" };
    };
    const consumerFor = (token: unknown): Consumer | undefined => {
      if (typeof token !== "string" || token.length > 2048) return undefined;
      const supplied = sha(token);
      let found: Consumer | undefined;
      for (const entry of consumers) if (hashEqual(supplied, entry.bindingHash)) found = entry;
      return found;
    };
    // New credentials are stored only as AES-GCM envelopes keyed by each consumer's binding secret.
    const deliveryKey = (consumer: Consumer): Buffer => Buffer.from(hkdfSync("sha256", consumer.bindingToken, configDigest,
      `file-origin-consumer-credential/v1\n${consumer.consumerId}`, 32));
    const sealDelivery = (consumer: Consumer, epoch: number, token: string): string => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", deliveryKey(consumer), iv);
      cipher.setAAD(Buffer.from(`${consumer.consumerId}\n${epoch}`));
      const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
    };
    const openDelivery = (consumer: Consumer, epoch: number, value: string): string => {
      try {
        const raw = Buffer.from(value, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", deliveryKey(consumer), raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${consumer.consumerId}\n${epoch}`));
        decipher.setAuthTag(raw.subarray(12, 28));
        const token = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
        check(/^[A-Za-z0-9_.-]{16,2048}$/u.test(token), "ORIGIN_DELIVERY_INVALID");
        return token;
      } catch { throw new DungeonQHostError("ORIGIN_DELIVERY_INVALID"); }
    };
    const ruleView = (row: RuleRow): FileOriginResponseRule => ({
      actionId: row.action_id, kind: row.kind as FileOriginResponseRule["kind"], incidentId: row.incident_id,
      subjects: JSON.parse(row.subjects) as string[], route: row.route, permission: row.permission, createdAt: row.created_at,
      expiresAt: row.expires_at,
      state: (row.state === "ACTIVE" && row.expires_at !== null && clock() >= row.expires_at ? "EXPIRED" : row.state) as FileOriginResponseRule["state"]
    });
    const activeRules = (): FileOriginResponseRule[] => all<RuleRow>("SELECT * FROM response_rules WHERE state='ACTIVE' ORDER BY rowid")
      .map(ruleView).filter(rule => rule.state === "ACTIVE");
    const routeOf = (operation: string): FileOriginResponseRoute => operation === "snapshot" ? "business-overview"
      : operation === "write" ? "business-write" : operation === "issue-ticket" ? "business-ticket" : "business-read";
    // Rate windows are process memory; they are bounded by the rule count and reset on restart.
    const rateWindows = new Map<string, number[]>();
    const rateGate = (rule: FileOriginResponseRule): void => {
      const now = clock();
      const recent = (rateWindows.get(rule.actionId) ?? []).filter(at => now - at < fileOriginResponseLimits.rateLimitWindowMs);
      rateWindows.set(rule.actionId, recent);
      check(recent.length < fileOriginResponseLimits.rateLimitMaxRequests, "RATE_LIMITED");
      recent.push(now);
    };
    const addAdmission = (context: string, accepted: boolean, requestId: string): number => {
      assertStorage(); capacity("admissions");
      return Number(database.prepare("INSERT INTO admissions(context,accepted,request_id) VALUES(?,?,?)").run(context, Number(accepted), requestId).lastInsertRowid);
    };
    const assertFile = (): ReturnType<typeof fstatSync> => {
      assertTargetSegments();
      check(targetFd !== undefined, "TARGET_UNAVAILABLE");
      const info = fstatSync(targetFd, { bigint: true });
      const pathInfo = lstatSync(target, { bigint: true });
      check(info.isFile() && pathInfo.isFile() && !pathInfo.isSymbolicLink() && info.nlink === 1n && pathInfo.nlink === 1n
        && info.ino === pathInfo.ino && info.dev === pathInfo.dev
        && info.ino.toString() === baseline.inode && info.dev.toString() === baseline.device
        && (Number(info.mode) & 0o777) === baseline.mode && (Number(pathInfo.mode) & 0o777) === baseline.mode
        && Number(info.size) === baseline.sizeBytes && Number(info.mtimeMs) === baseline.modifiedAtMs, "TARGET_CHANGED");
      return info;
    };
    const inspectTarget = (purpose: FileOriginAccessIntent["purpose"], requestId: string, admission: number | null): string | undefined => {
      assertStorage(); capacity("access_intents");
      // FULL synchronous commit precedes open/read. PENDING means a read may have happened.
      const intent = Number(database.prepare("INSERT INTO access_intents(admission_seq,purpose,request_id,state,bytes_read) VALUES(?,?,?,'PENDING',NULL)")
        .run(admission, purpose, requestId).lastInsertRowid);
      let bytesRead = false;
      let bytes: Buffer | undefined;
      try {
        if (targetFd === undefined) targetFd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = assertFile();
        bytes = Buffer.alloc(baseline.sizeBytes + 1);
        let total = 0;
        while (total < bytes.length) {
          bytesRead = true;
          const count = readSync(targetFd, bytes, total, bytes.length - total, total);
          if (count === 0) break;
          total += count;
        }
        const after = assertFile();
        check(before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs && total === baseline.sizeBytes
          && total <= dungeonqMaximumTargetBytes && sha(bytes.subarray(0, total)) === baseline.sha256, "TARGET_CHANGED");
        // The owner-staged artificial target may be arbitrary bytes. A stable, explicit
        // encoding also lets the control and synthetic arms expose the same document shape.
        const contents = purpose === "BUSINESS" ? bytes.subarray(0, total).toString("base64") : undefined;
        assertStorage();
        database.prepare("UPDATE access_intents SET state=?,bytes_read=1,digest=? WHERE seq=?")
          .run(purpose === "BUSINESS" ? "READ" : "VERIFIED", baseline.sha256, intent);
        return contents;
      } catch (error) {
        const code = error instanceof DungeonQHostError ? error.code : "TARGET_UNAVAILABLE";
        try {
          transact(() => {
            database.prepare("UPDATE access_intents SET state='FAILED',bytes_read=?,error=? WHERE seq=?").run(Number(bytesRead), code, intent);
            database.prepare("UPDATE meta SET failure=? WHERE id=1").run(code);
          });
        } catch { /* A durable PENDING intent is deliberately retained if storage failed. */ }
        throw new DungeonQHostError(code);
      } finally { bytes?.fill(0); }
    };
    assertHealthy();
    inspectTarget("STARTUP", "startup", null);
    const report = (): FileOriginReport => {
      assertHealthy(); inspectTarget("WITNESS", "witness", null);
      const admissions = all<Admission>("SELECT * FROM admissions ORDER BY seq");
      const accessIntents = all<FileOriginAccessIntent>("SELECT * FROM access_intents ORDER BY seq");
      check(admissions.every((row, index) => row.seq === index + 1)
        && accessIntents.every((row, index) => row.seq === index + 1 && row.state !== "PENDING" && row.state !== "FAILED"
          && (row.admission_seq === null || admissions[row.admission_seq - 1]?.accepted === 1)), "ORIGIN_AUDIT_INCOMPLETE");
      const targetReads = accessIntents.filter(row => row.purpose === "BUSINESS");
      return { schemaVersion: "dungeonq.origin-witness/v1", resource: "initial-machine-artificial-file", stateDigest: baseline.sha256,
        configDigest, ...(rotating ? { credentialEpoch: credential().epoch } : {}), admissions, accepted: admissions.filter(row => row.accepted === 1).length,
        rejected: admissions.filter(row => row.accepted === 0).length,
        acceptedContexts: [...new Set(admissions.filter(row => row.accepted === 1).map(row => row.context))],
        highWater: admissions.at(-1)?.seq ?? 0, targetReads, accessIntents, targetReadCount: targetReads.length,
        witnessReadCount: accessIntents.filter(row => row.purpose !== "BUSINESS").length, revision: meta().revision, complete: true };
    };
    const record = (key: string): RecordRow | undefined => key === targetKey
      ? { key, value: "null", revision: 1 } : one<RecordRow>("SELECT * FROM records WHERE key=?", key);
    const canRead = (key: string, effective: FileOriginAccessPolicy = policy): boolean => key === targetKey ? effective.readTarget : effective.readOtherRecords;
    // Tickets are bound to the credential epoch the caller presented (the current epoch outside response mode).
    const ticketToken = (id: string, epoch: number): string => `FILE_ORIGIN_${id}.${createHmac("sha256", options.normalToken)
      .update(`file-origin-ticket/v3\n${configDigest}\n${policy.tenantId}\n${policy.principalId}\n${epoch}\n${id}`).digest("hex")}`;
    const findTicket = (value: unknown, key: string, replay: boolean, epoch: number): Ticket => {
      check(typeof value === "string" && value.length <= 8192, "TICKET_INVALID");
      const id = /^FILE_ORIGIN_([a-f0-9-]{36})\.[a-f0-9]{64}$/u.exec(value)?.[1];
      check(id && tokenEqual(value, ticketToken(id, epoch)), "TICKET_AUTHORITY_DENIED");
      const ticket = one<Ticket>("SELECT * FROM tickets WHERE id=?", id);
      check(ticket, "TICKET_AUTHORITY_DENIED");
      check(Date.now() < ticket.expires, "TICKET_EXPIRED");
      check((JSON.parse(ticket.scope) as string[]).includes(key), "TICKET_SCOPE_DENIED");
      check(replay || ticket.uses < ticket.maximum, "TICKET_EXHAUSTED");
      return ticket;
    };
    const materialize = (skeleton: JsonRecord, operation: string, requestId: string, admission: number, epoch: number): JsonRecord => {
      const result = structuredClone(skeleton);
      const hasTarget = (operation === "read" || operation === "use-ticket") && result.key === targetKey;
      const contents = inspectTarget(hasTarget ? "BUSINESS" : "GUARD", requestId, admission);
      const targetValue = { documentId: targetKey, classification: "RESTRICTED", status: "AVAILABLE", contentEncoding: "base64", contents };
      if (operation === "snapshot") {
        // Rebuild the response from a strict projection, including cached snapshots
        // created by an older worker. No record value reaches the overview surface.
        result.records = (result.records as JsonRecord[]).map(row => ({ key: row.key, revision: row.revision,
          classification: row.key === targetKey ? "RESTRICTED" : "INTERNAL", status: "AVAILABLE" }));
      } else if (hasTarget) result.value = targetValue;
      if (operation === "issue-ticket") result.ticket = ticketToken(String(result.ticketId), epoch);
      return result;
    };
    /** A diverted target read gets the synthetic decoy; the protected target is never opened. */
    const divert = (operation: string, args: unknown, context: string, requestId: string): JsonRecord => {
      check(operation === "read" || operation === "use-ticket", "ROUTE_DIVERTED_DENIED");
      check(args !== null && typeof args === "object" && !Array.isArray(args), "INVALID_ENVELOPE");
      const key = (args as JsonRecord).key ?? (operation === "use-ticket" ? targetKey : undefined);
      check(key === targetKey, "RECORD_UNKNOWN");
      addAdmission(context, false, requestId);
      return { key: targetKey, value: { documentId: targetKey, classification: "RESTRICTED", status: "AVAILABLE", contentEncoding: "base64",
        contents: divertedContents }, recordRevision: 1, revision: meta().revision };
    };
    const business = (input: unknown, suppliedToken: string | undefined, bindingHeader: unknown): { body: JsonRecord; hintEpoch: number | null } => {
      let context = "invalid";
      let requestId = "invalid";
      let admission: number | undefined;
      let newRequest = false;
      try {
        if (input && typeof input === "object") {
          const raw = input as JsonRecord;
          context = safeLabel(raw.contextId, "invalid"); requestId = safeLabel(raw.requestId, "invalid");
        }
        assertStorage();
        const current = credential();
        let epoch = current.epoch;
        let consumer: Consumer | undefined;
        let superseded = false;
        if (!responding) {
          check(typeof suppliedToken === "string" && timingSafeEqual(Buffer.from(sha(suppliedToken)), Buffer.from(current.token_hash)), "ORIGIN_AUTHORITY_DENIED");
        } else {
          if (bindingHeader !== undefined) {
            consumer = consumerFor(bindingHeader);
            check(consumer, "CONSUMER_BINDING_DENIED");
          }
          check(typeof suppliedToken === "string" && suppliedToken.length <= 2048, "ORIGIN_AUTHORITY_DENIED");
          const supplied = sha(suppliedToken);
          if (!hashEqual(supplied, current.token_hash)) {
            const row = responseRow();
            // The superseded credential is honoured only inside the overlap and only with a registered consumer binding.
            check(overlapView(row).accepting && row.previous_hash !== null && row.previous_epoch !== null
              && hashEqual(supplied, row.previous_hash) && consumer !== undefined, "ORIGIN_AUTHORITY_DENIED");
            epoch = row.previous_epoch; superseded = true;
          }
        }
        const reply = (body: JsonRecord): { body: JsonRecord; hintEpoch: number | null } => ({ body, hintEpoch: superseded ? current.epoch : null });
        assertHealthy();
        validate(() => passive.runtimeEnvelope(input, ["contextId", "requestId", "operation", "args"],
          responding ? ["tenantId", "principalId", "role", "sourceId"] : ["tenantId", "principalId", "role"], 32768));
        const value = input as JsonRecord;
        // Outside response mode, and for bound consumers, only the ordinary context exists. Unbound callers in
        // response mode carry a context label so flagged-subject rules can apply; the credential stays the authority.
        if (responding && consumer === undefined) check(typeof value.contextId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.contextId), "ORIGIN_AUTHORITY_DENIED");
        else check(value.contextId === "ordinary", "ORIGIN_AUTHORITY_DENIED");
        check(value.sourceId === undefined || typeof value.sourceId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.sourceId), "SOURCE_ID_INVALID");
        check(value.tenantId === undefined || value.tenantId === policy.tenantId, "ORIGIN_TENANT_DENIED");
        check(value.principalId === undefined || value.principalId === policy.principalId, "ORIGIN_PRINCIPAL_DENIED");
        // A role string is accepted as an untrusted claim for audit/probe compatibility.
        // It never enters the authorization decision.
        check(value.role === undefined || typeof value.role === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.role), "ORIGIN_ROLE_INVALID");
        check(typeof value.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId), "REQUEST_ID_INVALID");
        check(typeof value.operation === "string" && ["snapshot", "read", "write", "issue-ticket", "use-ticket"].includes(value.operation), "OPERATION_DENIED");
        const operation = value.operation;
        const args = value.args as JsonRecord;
        let effective = policy;
        if (responding && consumer === undefined) {
          const subjects = [`context:${String(value.contextId)}`, ...(value.sourceId === undefined ? [] : [`source:${String(value.sourceId)}`])];
          const rules = activeRules().filter(rule => rule.subjects.some(subject => subjects.includes(subject)));
          for (const rule of rules) if (rule.kind === "RATE_LIMIT") rateGate(rule);
          if (rules.some(rule => rule.kind === "REROUTE" && rule.route === routeOf(operation))) return reply(divert(operation, args, context, requestId));
          const revoked = new Set(rules.filter(rule => rule.kind === "NARROW").map(rule => rule.permission));
          if (revoked.size > 0) {
            effective = { ...policy, readTarget: policy.readTarget && !revoked.has("readTarget"), readOtherRecords: policy.readOtherRecords && !revoked.has("readOtherRecords"),
              writeOtherRecords: policy.writeOtherRecords && !revoked.has("writeOtherRecords"), issueTickets: policy.issueTickets && !revoked.has("issueTickets") };
          }
        }
        const inputDigest = jsonDigest(value);
        const previous = one<RequestRow>("SELECT * FROM requests WHERE id=?", requestId);
        check(!previous || !rotating || one<{ epoch: number }>("SELECT epoch FROM request_epochs WHERE request_id=?", requestId)?.epoch === epoch,
          "REQUEST_EPOCH_DENIED");
        check(!previous || previous.digest === inputDigest, "IDEMPOTENCY_CONFLICT");
        check(!previous || previous.state === "DONE", "ORIGIN_OPERATION_INCOMPLETE");
        let key = targetKey;
        let ticket: Ticket | undefined;
        let scope: string[] = [];
        let ttlMs = 60_000;
        let maxUses = 1;
        validate(() => {
          if (operation === "snapshot") passive.runtimeEnvelope(args, []);
          else if (operation === "read") {
            passive.runtimeEnvelope(args, ["key"]); key = passive.runtimeId(args.key);
            check(canRead(key, effective), "ORIGIN_SCOPE_DENIED");
            check(record(key), "RECORD_UNKNOWN");
          } else if (operation === "write") {
            passive.runtimeEnvelope(args, ["key", "value", "expectedRevision"]); key = passive.runtimeId(args.key);
            check(key !== targetKey, "TARGET_IMMUTABLE");
            check(effective.writeOtherRecords, "ORIGIN_SCOPE_DENIED");
            check(Number.isSafeInteger(args.expectedRevision) && Number(args.expectedRevision) >= 0, "REVISION_INVALID");
            if (!previous) check(args.expectedRevision === meta().revision, "REVISION_CONFLICT");
            passive.runtimeValue(args.value, 2048);
            if (!record(key)) capacity("records", 127);
          } else if (operation === "issue-ticket") {
            passive.runtimeEnvelope(args, [], ["scope", "ttlMs", "maxUses"]);
            check(effective.issueTickets, "ORIGIN_SCOPE_DENIED");
            const rawScope = args.scope ?? [targetKey];
            check(Array.isArray(rawScope) && rawScope.length >= 1 && rawScope.length <= 16 && new Set(rawScope).size === rawScope.length, "TICKET_SCOPE_INVALID");
            scope = rawScope.map(entry => passive.runtimeId(entry));
            check(scope.every(entry => canRead(entry, effective)), "ORIGIN_SCOPE_DENIED");
            check(scope.every(entry => record(entry)), "RECORD_UNKNOWN");
            ttlMs = args.ttlMs === undefined ? ttlMs : Number(args.ttlMs);
            maxUses = args.maxUses === undefined ? maxUses : Number(args.maxUses);
            check((args.ttlMs === undefined || typeof args.ttlMs === "number") && Number.isSafeInteger(ttlMs) && ttlMs >= 1 && ttlMs <= 3_600_000, "TICKET_TTL_INVALID");
            check((args.maxUses === undefined || typeof args.maxUses === "number") && Number.isSafeInteger(maxUses) && maxUses >= 1 && maxUses <= 8, "TICKET_USES_INVALID");
            if (!previous) capacity("tickets", 512);
            else {
              check(previous.response, "ORIGIN_OPERATION_INCOMPLETE");
              const issued = JSON.parse(previous.response) as JsonRecord;
              check(Date.now() < Number(issued.expiresAt), "TICKET_EXPIRED");
            }
          } else {
            passive.runtimeEnvelope(args, ["ticket"], ["key"]); key = passive.runtimeId(args.key ?? targetKey);
            check(canRead(key, effective), "ORIGIN_SCOPE_DENIED");
            ticket = findTicket(args.ticket, key, Boolean(previous), epoch); check(record(key), "RECORD_UNKNOWN");
          }
        });
        // Effectful requests keep their own 2048 bound. Read-only requests (a legitimate consumer probes once per second)
        // are bounded only by the audit limit shared with admissions, so ordinary traffic is not stopped after 2048 probes
        // (DQ-JOURNAL-016, ADR-DQ-021).
        if (!previous) {
          if (!["snapshot", "read"].includes(operation)) {
            check((one<{ n: number }>("SELECT count(*) AS n FROM requests WHERE operation NOT IN ('snapshot','read')")?.n ?? effectfulRequestLimit)
              < effectfulRequestLimit, "ORIGIN_AUDIT_LIMIT");
          }
          capacity("requests");
        }
        admission = transact(() => {
          const sequence = addAdmission(context, true, requestId);
          if (!previous) {
            database.prepare("INSERT INTO requests VALUES(?,?,?,'PENDING',NULL,NULL)").run(requestId, inputDigest, operation);
            if (rotating) database.prepare("INSERT INTO request_epochs VALUES(?,?)").run(requestId, epoch);
            newRequest = true;
          }
          return sequence;
        });
        if (previous) {
          check(previous.response, "ORIGIN_OPERATION_INCOMPLETE");
          return reply(materialize(JSON.parse(previous.response) as JsonRecord, operation, requestId, admission, epoch));
        }
        let skeleton: JsonRecord;
        const revision = meta().revision;
        if (operation === "snapshot") {
          skeleton = { tenantId: policy.tenantId, worldId: "ordinary-world", revision,
            records: [{ key: targetKey, revision: 1 }, ...all<RecordRow>("SELECT key,revision FROM records ORDER BY key")] };
        } else if (operation === "read" || operation === "use-ticket") {
          const row = record(key); check(row, "RECORD_UNKNOWN");
          skeleton = { key, value: key === targetKey ? null : JSON.parse(row.value) as unknown, recordRevision: row.revision, revision,
            ...(ticket ? { ticketId: ticket.id, usesRemaining: ticket.maximum - ticket.uses - 1 } : {}) };
        } else if (operation === "write") {
          skeleton = { key, value: args.value, recordRevision: revision + 1, revision: revision + 1 };
        } else {
          skeleton = { ticketId: randomUUID(), scope, issuedAt: Date.now(), expiresAt: Date.now() + ttlMs, maxUses, revision };
        }
        const response = materialize(skeleton, operation, requestId, admission, epoch);
        transact(() => {
          if (operation === "write") {
            database.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision")
              .run(key, JSON.stringify(args.value), revision + 1);
            database.prepare("UPDATE meta SET revision=? WHERE id=1").run(revision + 1);
          } else if (operation === "issue-ticket") {
            database.prepare("INSERT INTO tickets VALUES(?,?,?,?,0)").run(String(skeleton.ticketId), JSON.stringify(scope), Number(skeleton.expiresAt), maxUses);
          } else if (ticket) database.prepare("UPDATE tickets SET uses=uses+1 WHERE id=?").run(ticket.id);
          database.prepare("UPDATE requests SET state='DONE',response=? WHERE id=?").run(JSON.stringify(skeleton), requestId);
          if (consumer !== undefined && !superseded) {
            database.prepare("UPDATE consumer_deliveries SET first_success_at=? WHERE consumer_id=? AND epoch=? AND first_success_at IS NULL")
              .run(clock(), consumer.consumerId, epoch);
          }
        });
        return reply(response);
      } catch (error) {
        const code = errorCode(error);
        if (admission === undefined) addAdmission(context, false, requestId);
        else if (newRequest) {
          transact(() => {
            database.prepare("UPDATE requests SET state='FAILED',error=? WHERE id=?").run(code, requestId);
            database.prepare("UPDATE meta SET failure=? WHERE id=1").run(code);
          });
        }
        throw new DungeonQHostError(code);
      }
    };
    const controlStatus = (): { epoch: number; rotations: FileOriginRotationReceipt[] } => {
      assertHealthy();
      return { epoch: credential().epoch, rotations: all<{ receipt: string }>("SELECT receipt FROM credential_receipts ORDER BY rowid").map(row => JSON.parse(row.receipt) as FileOriginRotationReceipt) };
    };
    const rotate = (input: unknown): FileOriginRotationReceipt => {
      assertHealthy();
      // Response mode only rotates with an overlap and consumer delivery; an immediate switch would cut legitimate consumers.
      check(!responding, "ROTATION_REQUIRES_OVERLAP_DENIED");
      validate(() => passive.runtimeEnvelope(input, ["actionId", "expectedEpoch", "nextToken"], [], 4096));
      const value = input as JsonRecord;
      check(typeof value.actionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.actionId), "ACTION_ID_INVALID");
      check(Number.isSafeInteger(value.expectedEpoch) && Number(value.expectedEpoch) >= 0, "CREDENTIAL_EPOCH_INVALID");
      check(typeof value.nextToken === "string" && /^[A-Za-z0-9_.-]{16,2048}$/u.test(value.nextToken), "ORIGIN_CREDENTIAL_INVALID");
      const nextHash = sha(value.nextToken);
      const digest = jsonDigest({ actionId: value.actionId, expectedEpoch: value.expectedEpoch, nextHash });
      return transact(() => {
        const prior = one<{ input_digest: string; receipt: string }>("SELECT input_digest,receipt FROM credential_receipts WHERE action_id=?", value.actionId as string);
        if (prior) {
          check(prior.input_digest === digest, "IDEMPOTENCY_CONFLICT");
          return JSON.parse(prior.receipt) as FileOriginRotationReceipt;
        }
        const current = credential();
        check(current.epoch === value.expectedEpoch && current.epoch < Number.MAX_SAFE_INTEGER, "CREDENTIAL_EPOCH_CONFLICT");
        check(![sha(options.normalToken), sha(options.witnessToken), sha(options.rotationControlToken!), current.token_hash].includes(nextHash)
          && !one("SELECT action_id FROM credential_receipts WHERE next_hash=?", nextHash), "CREDENTIAL_REUSE_DENIED");
        check((one<{ n: number }>("SELECT count(*) AS n FROM credential_receipts")?.n ?? maximumEntries) < maximumEntries, "ORIGIN_AUDIT_LIMIT");
        const receipt: FileOriginRotationReceipt = { actionId: value.actionId as string, at: new Date().toISOString(), previousEpoch: current.epoch, epoch: current.epoch + 1, monotonicNs: process.hrtime.bigint().toString() };
        database.prepare("UPDATE credential_state SET epoch=?,token_hash=? WHERE id=1").run(receipt.epoch, nextHash);
        database.prepare("INSERT INTO credential_receipts VALUES(?,?,?,?)").run(receipt.actionId, digest, nextHash, JSON.stringify(receipt));
        return receipt;
      });
    };
    const responseStateView = (): FileOriginResponseState => {
      assertHealthy();
      const row = responseRow();
      const current = credential();
      const deliveries = all<{ consumer_id: string; epoch: number; fetched_at: number | null; first_success_at: number | null }>(
        "SELECT consumer_id,epoch,fetched_at,first_success_at FROM consumer_deliveries WHERE epoch=?", current.epoch);
      return { schemaVersion: "dungeonq.file-origin-response-state/v1", revision: row.revision,
        credential: { epoch: current.epoch, overlap: { state: overlapView(row).state, previousEpoch: row.previous_epoch, endsAt: row.overlap_ends },
          consumers: consumers.map(entry => {
            const delivery = deliveries.find(item => item.consumer_id === entry.consumerId);
            return { consumerId: entry.consumerId, deliveredEpoch: delivery?.epoch ?? null, fetchedAt: delivery?.fetched_at ?? null,
              firstSuccessAt: delivery?.first_success_at ?? null };
          }) },
        rules: all<RuleRow>("SELECT * FROM response_rules ORDER BY rowid").map(ruleView) };
    };
    const responseKinds: Record<string, string[]> = {
      ROTATE_OVERLAP: ["expectedEpoch", "overlapSeconds"], REROUTE: ["subjects", "route"], NARROW: ["subjects", "permission"],
      RATE_LIMIT: ["subjects", "durationSeconds"], REVOKE_PREVIOUS: []
    };
    const actionIdValid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
    const responseApply = (input: unknown): JsonRecord => {
      assertHealthy();
      const base = ["actionId", "kind", "incidentId", "expectedRevision"];
      validate(() => passive.runtimeEnvelope(input, base, ["expectedEpoch", "overlapSeconds", "subjects", "route", "permission", "durationSeconds"], 8192));
      const value = input as JsonRecord;
      const kind = String(value.kind);
      const fields = Object.hasOwn(responseKinds, kind) ? responseKinds[kind] : undefined;
      check(fields && Object.keys(value).every(key => base.includes(key) || fields.includes(key)) && fields.every(key => Object.hasOwn(value, key)), "RESPONSE_FIELDS_INVALID");
      check(actionIdValid(value.actionId), "ACTION_ID_INVALID");
      check(typeof value.incidentId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value.incidentId), "INCIDENT_ID_INVALID");
      check(Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0, "RESPONSE_REVISION_INVALID");
      let subjects: string[] = [];
      if (kind === "REROUTE" || kind === "NARROW" || kind === "RATE_LIMIT") {
        const raw = value.subjects;
        check(Array.isArray(raw) && raw.length >= 1 && raw.length <= fileOriginResponseLimits.maxSubjectsPerRule && new Set(raw).size === raw.length
          && raw.every(subject => typeof subject === "string" && /^(?:context|source):[A-Za-z0-9_-]{1,128}$/u.test(subject))
          && !raw.includes("context:ordinary"), "RESPONSE_SUBJECT_INVALID");
        subjects = raw as string[];
      }
      if (kind === "REROUTE") check((fileOriginResponseRoutes as readonly unknown[]).includes(value.route), "RESPONSE_ROUTE_INVALID");
      if (kind === "NARROW") check((fileOriginNarrowablePermissions as readonly unknown[]).includes(value.permission), "RESPONSE_PERMISSION_INVALID");
      if (kind === "RATE_LIMIT") {
        check(Number.isSafeInteger(value.durationSeconds) && Number(value.durationSeconds) >= 1
          && Number(value.durationSeconds) <= fileOriginResponseLimits.maxRateLimitSeconds, "RATE_LIMIT_DURATION_INVALID");
      }
      if (kind === "ROTATE_OVERLAP") {
        check(Number.isSafeInteger(value.expectedEpoch) && Number(value.expectedEpoch) >= 0, "CREDENTIAL_EPOCH_INVALID");
        check(Number.isSafeInteger(value.overlapSeconds) && Number(value.overlapSeconds) >= fileOriginResponseLimits.minOverlapSeconds
          && Number(value.overlapSeconds) <= fileOriginResponseLimits.maxOverlapSeconds, "OVERLAP_INVALID");
      }
      const actionId = value.actionId as string;
      const digest = jsonDigest(value);
      return transact(() => {
        const prior = one<{ input_digest: string; receipt: string }>("SELECT input_digest,receipt FROM response_actions WHERE action_id=?", actionId);
        if (prior) {
          check(prior.input_digest === digest, "IDEMPOTENCY_CONFLICT");
          return JSON.parse(prior.receipt) as JsonRecord;
        }
        check((one<{ n: number }>("SELECT count(*) AS n FROM response_actions")?.n ?? fileOriginResponseLimits.maxActions) < fileOriginResponseLimits.maxActions, "ORIGIN_AUDIT_LIMIT");
        const row = responseRow();
        check(row.revision === value.expectedRevision, "RESPONSE_STATE_CONFLICT");
        const now = clock();
        const revision = row.revision + 1;
        const common = { actionId, kind, incidentId: value.incidentId as string, at: new Date(now).toISOString(), revision };
        let receipt: JsonRecord;
        if (kind === "ROTATE_OVERLAP") {
          const current = credential();
          check(current.epoch === value.expectedEpoch && current.epoch < Number.MAX_SAFE_INTEGER, "CREDENTIAL_EPOCH_CONFLICT");
          check(!overlapView(row).accepting, "CREDENTIAL_OVERLAP_CONFLICT");
          check(!one("SELECT action_id FROM credential_receipts WHERE action_id=?", actionId), "IDEMPOTENCY_CONFLICT");
          check((one<{ n: number }>("SELECT count(*) AS n FROM credential_receipts")?.n ?? maximumEntries) < maximumEntries, "ORIGIN_AUDIT_LIMIT");
          const nextToken = randomBytes(32).toString("base64url");
          const nextHash = sha(nextToken);
          check(!one("SELECT action_id FROM credential_receipts WHERE next_hash=?", nextHash) && nextHash !== current.token_hash, "CREDENTIAL_REUSE_DENIED");
          const epoch = current.epoch + 1;
          const overlapEndsAt = now + Number(value.overlapSeconds) * 1000;
          receipt = { ...common, previousEpoch: current.epoch, epoch, overlapEndsAt, deliveredTo: consumers.map(entry => entry.consumerId),
            monotonicNs: process.hrtime.bigint().toString() };
          database.prepare("UPDATE credential_state SET epoch=?,token_hash=? WHERE id=1").run(epoch, nextHash);
          database.prepare("UPDATE response_state SET revision=?,previous_hash=?,previous_epoch=?,overlap_ends=?,overlap_state='OVERLAP' WHERE id=1")
            .run(revision, current.token_hash, current.epoch, overlapEndsAt);
          database.prepare("INSERT INTO credential_receipts VALUES(?,?,?,?)").run(actionId, digest, nextHash, JSON.stringify(receipt));
          for (const entry of consumers) {
            database.prepare("INSERT INTO consumer_deliveries VALUES(?,?,?,NULL,NULL)").run(entry.consumerId, epoch, sealDelivery(entry, epoch, nextToken));
          }
        } else if (kind === "REVOKE_PREVIOUS") {
          check(row.overlap_state !== "NONE" && row.overlap_state !== "REVOKED", "CREDENTIAL_OVERLAP_CONFLICT");
          receipt = { ...common, previousEpoch: row.previous_epoch };
          database.prepare("UPDATE response_state SET revision=?,overlap_state='REVOKED' WHERE id=1").run(revision);
        } else {
          check((one<{ n: number }>("SELECT count(*) AS n FROM response_rules")?.n ?? fileOriginResponseLimits.maxRules) < fileOriginResponseLimits.maxRules, "ORIGIN_AUDIT_LIMIT");
          const expiresAt = kind === "RATE_LIMIT" ? now + Number(value.durationSeconds) * 1000 : null;
          const route = kind === "REROUTE" ? value.route as string : null;
          const permission = kind === "NARROW" ? value.permission as string : null;
          receipt = { ...common, subjects, route, permission, expiresAt };
          database.prepare("INSERT INTO response_rules VALUES(?,?,?,?,?,?,?,?,'ACTIVE')")
            .run(actionId, kind, value.incidentId as string, JSON.stringify(subjects), route, permission, now, expiresAt);
          database.prepare("UPDATE response_state SET revision=? WHERE id=1").run(revision);
        }
        database.prepare("INSERT INTO response_actions VALUES(?,?,?,?)").run(actionId, digest, kind, JSON.stringify(receipt));
        return receipt;
      });
    };
    const responseRollback = (input: unknown): JsonRecord => {
      assertHealthy();
      validate(() => passive.runtimeEnvelope(input, ["rollbackId", "actionId", "expectedRevision"], [], 4096));
      const value = input as JsonRecord;
      check(actionIdValid(value.rollbackId) && actionIdValid(value.actionId) && value.rollbackId !== value.actionId, "ACTION_ID_INVALID");
      check(Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0, "RESPONSE_REVISION_INVALID");
      const digest = jsonDigest(value);
      return transact(() => {
        const prior = one<{ input_digest: string; receipt: string }>("SELECT input_digest,receipt FROM response_actions WHERE action_id=?", value.rollbackId as string);
        if (prior) {
          check(prior.input_digest === digest, "IDEMPOTENCY_CONFLICT");
          return JSON.parse(prior.receipt) as JsonRecord;
        }
        check((one<{ n: number }>("SELECT count(*) AS n FROM response_actions")?.n ?? fileOriginResponseLimits.maxActions) < fileOriginResponseLimits.maxActions, "ORIGIN_AUDIT_LIMIT");
        const row = responseRow();
        check(row.revision === value.expectedRevision, "RESPONSE_STATE_CONFLICT");
        const action = one<{ kind: string; receipt: string }>("SELECT kind,receipt FROM response_actions WHERE action_id=?", value.actionId as string);
        check(action && action.kind !== "ROLLBACK", "RESPONSE_ACTION_UNKNOWN");
        const revision = row.revision + 1;
        const receipt: JsonRecord = { rollbackId: value.rollbackId, actionId: value.actionId, kind: action.kind, at: new Date(clock()).toISOString(), revision };
        if (action.kind === "ROTATE_OVERLAP") {
          // Rollback holds the overlap open for bound consumers only. A credential whose overlap already ended stays revoked.
          check(credential().epoch === Number((JSON.parse(action.receipt) as JsonRecord).epoch), "CREDENTIAL_EPOCH_CONFLICT");
          check(overlapView(row).state === "OVERLAP", "CREDENTIAL_REVOKED_CONFLICT");
          database.prepare("UPDATE response_state SET revision=?,overlap_state='HELD' WHERE id=1").run(revision);
          receipt.overlapState = "HELD";
        } else {
          check(action.kind !== "REVOKE_PREVIOUS", "RESPONSE_ROLLBACK_UNSUPPORTED");
          const rule = one<RuleRow>("SELECT * FROM response_rules WHERE action_id=?", value.actionId as string);
          check(rule && rule.state === "ACTIVE", "RESPONSE_ROLLBACK_CONFLICT");
          database.prepare("UPDATE response_rules SET state='ROLLED_BACK' WHERE action_id=?").run(value.actionId as string);
          database.prepare("UPDATE response_state SET revision=? WHERE id=1").run(revision);
          receipt.ruleState = "ROLLED_BACK";
        }
        database.prepare("INSERT INTO response_actions VALUES(?,?,'ROLLBACK',?)").run(value.rollbackId as string, digest, JSON.stringify(receipt));
        return receipt;
      });
    };
    const responseReceipt = (input: unknown): JsonRecord => {
      assertHealthy();
      validate(() => passive.runtimeEnvelope(input, ["actionId"], [], 1024));
      const value = input as JsonRecord;
      check(actionIdValid(value.actionId), "ACTION_ID_INVALID");
      const row = one<{ receipt: string }>("SELECT receipt FROM response_actions WHERE action_id=?", value.actionId);
      return row ? { found: true, receipt: JSON.parse(row.receipt) as JsonRecord } : { found: false };
    };
    const consumerCredential = (token: string | undefined): JsonRecord => {
      assertHealthy();
      const consumer = consumerFor(token);
      check(consumer, "UNAUTHORIZED");
      const current = credential();
      const row = one<{ sealed: string; fetched_at: number | null }>("SELECT sealed,fetched_at FROM consumer_deliveries WHERE consumer_id=? AND epoch=?",
        consumer.consumerId, current.epoch);
      if (!row) return { consumerId: consumer.consumerId, epoch: current.epoch, token: null };
      const token_ = openDelivery(consumer, current.epoch, row.sealed);
      if (row.fetched_at === null) {
        database.prepare("UPDATE consumer_deliveries SET fetched_at=? WHERE consumer_id=? AND epoch=?").run(clock(), consumer.consumerId, current.epoch);
      }
      return { consumerId: consumer.consumerId, epoch: current.epoch, token: token_ };
    };
    const send = (response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", ...extra });
      response.end(JSON.stringify(value));
    };
    const readBody = async (request: IncomingMessage): Promise<unknown> => {
      check(/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "") && !request.headers["content-encoding"], "CONTENT_TYPE_INVALID");
      const chunks: Buffer[] = []; let length = 0;
      for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
        length += chunk.length; check(length <= 32768, "BODY_LIMIT"); chunks.push(chunk);
      }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
      catch { throw new DungeonQHostError("JSON_INVALID"); }
    };
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void (async () => {
        let delegated = false;
        try {
          const address = server.address();
          check(address && typeof address !== "string" && request.headers.host === `127.0.0.1:${address.port}`
            && request.socket.remoteAddress === "127.0.0.1", "HOST_DENIED");
          check(!request.headers.origin && !request.headers.cookie
            && (!request.headers["sec-fetch-site"] || ["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))), "BROWSER_DENIED");
          if (rotating && (request.url === "/control/rotate" || request.url === "/control/status")) {
            check(tokenEqual(bearer(request), options.rotationControlToken!), "UNAUTHORIZED");
            check(request.url === "/control/status" ? request.method === "GET" : request.method === "POST", "NOT_FOUND");
            const result = request.url === "/control/status" ? controlStatus() : rotate(await readBody(request));
            delegated = true; send(response, 200, result); return;
          }
          if (responding && request.url?.startsWith("/control/response/")) {
            check(tokenEqual(bearer(request), options.rotationControlToken!), "UNAUTHORIZED");
            const route = request.url.slice("/control/response/".length);
            check(route === "state" ? request.method === "GET" : ["apply", "rollback", "receipt"].includes(route) && request.method === "POST", "NOT_FOUND");
            const result = route === "state" ? responseStateView()
              : route === "apply" ? responseApply(await readBody(request))
                : route === "rollback" ? responseRollback(await readBody(request)) : responseReceipt(await readBody(request));
            delegated = true; send(response, 200, result); return;
          }
          if (responding && request.url === "/consumer/credential" && request.method === "GET") {
            const result = consumerCredential(bearer(request));
            delegated = true; send(response, 200, result); return;
          }
          if (request.url === "/witness" && request.method === "GET") {
            check(tokenEqual(bearer(request), options.witnessToken), "UNAUTHORIZED");
            delegated = true; send(response, 200, report()); return;
          }
          check(request.url === "/business" && request.method === "POST", "NOT_FOUND");
          const input = await readBody(request);
          const binding = request.headers[fileOriginConsumerBindingHeader];
          // business() records its own admission, including rejections.
          delegated = true;
          const result = business(input, bearer(request), typeof binding === "string" || binding === undefined ? binding : "invalid");
          send(response, 200, result.body, result.hintEpoch === null ? {} : { "X-DungeonQ-Credential-Epoch": String(result.hintEpoch) });
        } catch (error) {
          let code = errorCode(error);
          if (!delegated) {
            try { addAdmission("invalid", false, "transport-rejected"); }
            catch { code = "ORIGIN_WITNESS_UNAVAILABLE"; }
          }
          if (!response.headersSent) send(response, /UNAUTHORIZED/u.test(code) ? 401 : /RATE_LIMITED/u.test(code) ? 429 : /DENIED/u.test(code) ? 403
            : /CONFLICT/u.test(code) ? 409 : /UNAVAILABLE|INCOMPLETE|CHANGED/u.test(code) ? 503 : 400, { error: { code, message: code.replaceAll("_", " ") } });
          else response.destroy();
        }
      })();
    });
    server.maxConnections = 64; server.headersTimeout = 5000; server.requestTimeout = 5000;
    server.timeout = 6000; server.keepAliveTimeout = 1000;
    await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(options.port ?? 0, host, accept); });
    const address = server.address(); check(address && typeof address !== "string", "ORIGIN_START_FAILED");
    return { origin: `http://${host}:${address.port}`, report,
      async close() {
        if (closed) return;
        closed = true;
        await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); });
        release();
      } };
  } catch (error) { release(); throw new DungeonQHostError(errorCode(error)); }
}

export async function startFileOrigin(options: FileOriginOptions): Promise<FileOrigin> {
  try { return await openFileOrigin(options); }
  catch (error) { throw new DungeonQHostError(errorCode(error)); }
}
