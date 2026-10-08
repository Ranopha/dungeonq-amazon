import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, unlinkSync
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  dungeonqLogicalTargetId, dungeonqMaximumTargetBytes, dungeonqTargetRelativePath,
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
const targetKey = dungeonqLogicalTargetId;
const maximumEntries = 20_000;
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
  targetReadCount: number; witnessReadCount: number; revision: number; complete: true;
};
export type FileOriginOptions = {
  targetPath: string; baseline: TargetWitness; directory: string; normalToken: string;
  witnessToken: string; host?: string; port?: number;
};
export type FileOrigin = { origin: string; report(): FileOriginReport; close(): Promise<void> };
type RequestRow = { id: string; digest: string; operation: string; state: string; response: string | null; error: string | null };
type Ticket = { id: string; scope: string; expires: number; maximum: number; uses: number };
type RecordRow = { key: string; value: string; revision: number };

/** A separate host connector: the real target never enters DungeonQ's canonical world. */
async function openFileOrigin(options: FileOriginOptions): Promise<FileOrigin> {
  const baseline = targetWitnessSchema.parse(options.baseline);
  check((baseline.mode & 0o077) === 0, "TARGET_PRIVATE_MODE_REQUIRED");
  check([options.normalToken, options.witnessToken].every(value => /^[A-Za-z0-9_.-]{16,2048}$/u.test(value))
    && options.normalToken !== options.witnessToken, "ORIGIN_CREDENTIAL_INVALID");
  const host = options.host ?? "127.0.0.1";
  check(host === "127.0.0.1", "ORIGIN_LOOPBACK_REQUIRED");
  check(options.port === undefined || Number.isSafeInteger(options.port) && options.port >= 0 && options.port <= 65535, "ORIGIN_PORT_INVALID");
  const requestedTarget = resolve(options.targetPath);
  const suffix = `${sep}${dungeonqTargetRelativePath.split("/").join(sep)}`;
  check(requestedTarget.endsWith(suffix), "HOST_PATH_NOT_ALLOWLISTED");
  const root = realpathSync(requestedTarget.slice(0, -suffix.length));
  const target = join(root, dungeonqTargetRelativePath);
  const assertTargetSegments = (): void => {
    let cursor = root;
    for (const segment of dungeonqTargetRelativePath.split("/").slice(0, -1)) {
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
      normalTokenHash: sha(options.normalToken), witnessTokenHash: sha(options.witnessToken), contextId: "ordinary" });
    if (!existing) {
      transact(() => {
        database.exec(schema);
        database.prepare("INSERT INTO meta VALUES(1,?,1,NULL)").run(configDigest);
      });
    } else {
      check(one<{ quick_check: string }>("PRAGMA quick_check")?.quick_check === "ok", "ORIGIN_STORAGE_CORRUPT");
      const expected = new DatabaseSync(":memory:");
      let expectedSchema: string;
      try { expected.exec(schema); expectedSchema = JSON.stringify(expected.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()); }
      finally { expected.close(); }
      check(JSON.stringify(database.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()) === expectedSchema, "ORIGIN_SCHEMA_CHANGED");
      check(one<{ config: string }>("SELECT config FROM meta WHERE id=1")?.config === configDigest, "ORIGIN_CONFIG_CHANGED");
    }
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
        configDigest, admissions, accepted: admissions.filter(row => row.accepted === 1).length,
        rejected: admissions.filter(row => row.accepted === 0).length,
        acceptedContexts: [...new Set(admissions.filter(row => row.accepted === 1).map(row => row.context))],
        highWater: admissions.at(-1)?.seq ?? 0, targetReads, accessIntents, targetReadCount: targetReads.length,
        witnessReadCount: accessIntents.filter(row => row.purpose !== "BUSINESS").length, revision: meta().revision, complete: true };
    };
    const record = (key: string): RecordRow | undefined => key === targetKey
      ? { key, value: "null", revision: 1 } : one<RecordRow>("SELECT * FROM records WHERE key=?", key);
    const ticketToken = (id: string): string => `FILE_ORIGIN_${id}.${createHmac("sha256", options.normalToken).update(`file-origin-ticket/v1\n${id}`).digest("hex")}`;
    const findTicket = (value: unknown, key: string, replay: boolean): Ticket => {
      check(typeof value === "string" && value.length <= 8192, "TICKET_INVALID");
      const id = /^FILE_ORIGIN_([a-f0-9-]{36})\.[a-f0-9]{64}$/u.exec(value)?.[1];
      check(id && tokenEqual(value, ticketToken(id)), "TICKET_AUTHORITY_DENIED");
      const ticket = one<Ticket>("SELECT * FROM tickets WHERE id=?", id);
      check(ticket, "TICKET_AUTHORITY_DENIED");
      check(Date.now() < ticket.expires, "TICKET_EXPIRED");
      check((JSON.parse(ticket.scope) as string[]).includes(key), "TICKET_SCOPE_DENIED");
      check(replay || ticket.uses < ticket.maximum, "TICKET_EXHAUSTED");
      return ticket;
    };
    const materialize = (skeleton: JsonRecord, operation: string, requestId: string, admission: number): JsonRecord => {
      const result = structuredClone(skeleton);
      const hasTarget = operation === "snapshot" || (operation === "read" || operation === "use-ticket") && result.key === targetKey;
      const contents = inspectTarget(hasTarget ? "BUSINESS" : "GUARD", requestId, admission);
      const targetValue = { documentId: targetKey, classification: "RESTRICTED", status: "AVAILABLE", contentEncoding: "base64", contents };
      if (operation === "snapshot") {
        result.records = (result.records as JsonRecord[]).map(row => row.key === targetKey ? { ...row, value: targetValue } : row);
      } else if (hasTarget) result.value = targetValue;
      if (operation === "issue-ticket") result.ticket = ticketToken(String(result.ticketId));
      return result;
    };
    const business = (input: unknown, suppliedToken: string | undefined): JsonRecord => {
      let context = "invalid";
      let requestId = "invalid";
      let admission: number | undefined;
      let newRequest = false;
      try {
        if (input && typeof input === "object") {
          const raw = input as JsonRecord;
          context = safeLabel(raw.contextId, "invalid"); requestId = safeLabel(raw.requestId, "invalid");
        }
        check(tokenEqual(suppliedToken, options.normalToken), "ORIGIN_AUTHORITY_DENIED");
        assertHealthy();
        validate(() => passive.runtimeEnvelope(input, ["contextId", "requestId", "operation", "args"], [], 32768));
        const value = input as JsonRecord;
        check(value.contextId === "ordinary", "ORIGIN_AUTHORITY_DENIED");
        check(typeof value.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId), "REQUEST_ID_INVALID");
        check(typeof value.operation === "string" && ["snapshot", "read", "write", "issue-ticket", "use-ticket"].includes(value.operation), "OPERATION_DENIED");
        const operation = value.operation;
        const args = value.args as JsonRecord;
        const inputDigest = jsonDigest(value);
        const previous = one<RequestRow>("SELECT * FROM requests WHERE id=?", requestId);
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
            check(record(key), "RECORD_UNKNOWN");
          } else if (operation === "write") {
            passive.runtimeEnvelope(args, ["key", "value", "expectedRevision"]); key = passive.runtimeId(args.key);
            check(key !== targetKey, "TARGET_IMMUTABLE");
            check(Number.isSafeInteger(args.expectedRevision) && Number(args.expectedRevision) >= 0, "REVISION_INVALID");
            if (!previous) check(args.expectedRevision === meta().revision, "REVISION_CONFLICT");
            passive.runtimeValue(args.value, 2048);
            if (!record(key)) capacity("records", 127);
          } else if (operation === "issue-ticket") {
            passive.runtimeEnvelope(args, [], ["scope", "ttlMs", "maxUses"]);
            const rawScope = args.scope ?? [targetKey];
            check(Array.isArray(rawScope) && rawScope.length >= 1 && rawScope.length <= 16 && new Set(rawScope).size === rawScope.length, "TICKET_SCOPE_INVALID");
            scope = rawScope.map(entry => passive.runtimeId(entry));
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
            ticket = findTicket(args.ticket, key, Boolean(previous)); check(record(key), "RECORD_UNKNOWN");
          }
        });
        if (!previous) capacity("requests", 2048);
        admission = transact(() => {
          const sequence = addAdmission(context, true, requestId);
          if (!previous) {
            database.prepare("INSERT INTO requests VALUES(?,?,?,'PENDING',NULL,NULL)").run(requestId, inputDigest, operation);
            newRequest = true;
          }
          return sequence;
        });
        if (previous) {
          check(previous.response, "ORIGIN_OPERATION_INCOMPLETE");
          return materialize(JSON.parse(previous.response) as JsonRecord, operation, requestId, admission);
        }
        let skeleton: JsonRecord;
        const revision = meta().revision;
        if (operation === "snapshot") {
          skeleton = { tenantId: "reference", worldId: "ordinary-world", revision,
            records: [{ key: targetKey, value: null, revision: 1 }, ...all<RecordRow>("SELECT * FROM records ORDER BY key").map(row => ({ ...row, value: JSON.parse(row.value) as unknown }))] };
        } else if (operation === "read" || operation === "use-ticket") {
          const row = record(key); check(row, "RECORD_UNKNOWN");
          skeleton = { key, value: key === targetKey ? null : JSON.parse(row.value) as unknown, recordRevision: row.revision, revision,
            ...(ticket ? { ticketId: ticket.id, usesRemaining: ticket.maximum - ticket.uses - 1 } : {}) };
        } else if (operation === "write") {
          skeleton = { key, value: args.value, recordRevision: revision + 1, revision: revision + 1 };
        } else {
          skeleton = { ticketId: randomUUID(), scope, issuedAt: Date.now(), expiresAt: Date.now() + ttlMs, maxUses, revision };
        }
        const response = materialize(skeleton, operation, requestId, admission);
        transact(() => {
          if (operation === "write") {
            database.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision")
              .run(key, JSON.stringify(args.value), revision + 1);
            database.prepare("UPDATE meta SET revision=? WHERE id=1").run(revision + 1);
          } else if (operation === "issue-ticket") {
            database.prepare("INSERT INTO tickets VALUES(?,?,?,?,0)").run(String(skeleton.ticketId), JSON.stringify(scope), Number(skeleton.expiresAt), maxUses);
          } else if (ticket) database.prepare("UPDATE tickets SET uses=uses+1 WHERE id=?").run(ticket.id);
          database.prepare("UPDATE requests SET state='DONE',response=? WHERE id=?").run(JSON.stringify(skeleton), requestId);
        });
        return response;
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
    const send = (response: ServerResponse, status: number, value: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
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
          if (request.url === "/witness" && request.method === "GET") {
            check(tokenEqual(bearer(request), options.witnessToken), "UNAUTHORIZED");
            delegated = true; send(response, 200, report()); return;
          }
          check(request.url === "/business" && request.method === "POST", "NOT_FOUND");
          const input = await readBody(request);
          delegated = true; send(response, 200, business(input, bearer(request)));
        } catch (error) {
          let code = errorCode(error);
          if (!delegated) {
            try { addAdmission("invalid", false, "transport-rejected"); }
            catch { code = "ORIGIN_WITNESS_UNAVAILABLE"; }
          }
          if (!response.headersSent) send(response, /UNAUTHORIZED/u.test(code) ? 401 : /DENIED/u.test(code) ? 403
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
