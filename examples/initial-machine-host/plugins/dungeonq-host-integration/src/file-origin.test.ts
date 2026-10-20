import { chmod, link, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { dungeonqTargetRelativePath } from "./contracts";
import { startFileOrigin, type FileOrigin, type FileOriginAccessPolicy, type FileOriginOptions } from "./file-origin";
import { captureTargetWitness, installHostLayout } from "./target-witness";

const targetContents = "ARTIFICIAL-CONTROL-CONTENTS-ONLY-測試";
const normalToken = "test-ordinary-bearer-keep-private";
const witnessToken = "test-witness-bearer-keep-private";
const roots: string[] = [];
const servers: FileOrigin[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const fullPolicy: FileOriginAccessPolicy = { tenantId: "reference", principalId: "ordinary-connector", readTarget: true,
  readOtherRecords: true, writeOtherRecords: true, issueTickets: true };

async function fixture(rotationControlToken?: string, accessPolicy: FileOriginAccessPolicy = fullPolicy): Promise<{ server: FileOrigin; options: FileOriginOptions; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "eva-file-origin-")); roots.push(root);
  await installHostLayout(root);
  const targetPath = join(root, dungeonqTargetRelativePath);
  await writeFile(targetPath, targetContents, { mode: 0o600 });
  const options = { targetPath, baseline: await captureTargetWitness(root), directory: join(root, "origin"), normalToken, witnessToken,
    accessPolicy,
    ...(rotationControlToken ? { rotationControlToken } : {}) };
  const server = await startFileOrigin(options); servers.push(server);
  return { server, options, root };
}
async function operate(server: FileOrigin, requestId: string, operation: string, args: Record<string, unknown> = {}, token = normalToken, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${server.origin}/business`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ contextId: "ordinary", requestId, operation, args, ...extra }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> & { error?: { code: string } } };
}
async function restart(server: FileOrigin, options: FileOriginOptions): Promise<FileOrigin> {
  await server.close();
  const next = await startFileOrigin(options); servers.push(next); return next;
}

describe("Initial Machine artificial file origin", () => {
  it("defaults to no protected content read when no access policy is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "eva-file-origin-default-deny-")); roots.push(root);
    await installHostLayout(root);
    const targetPath = join(root, dungeonqTargetRelativePath);
    await writeFile(targetPath, targetContents, { mode: 0o600 });
    const server = await startFileOrigin({ targetPath, baseline: await captureTargetWitness(root),
      directory: join(root, "origin"), normalToken, witnessToken });
    servers.push(server);
    expect((await operate(server, "default-overview", "snapshot")).status).toBe(200);
    expect((await operate(server, "default-target-read", "read", { key: "initial-machine-target" })).body.error?.code)
      .toBe("ORIGIN_SCOPE_DENIED");
    expect(server.report().targetReadCount).toBe(0);
  });

  it("returns metadata only in overview and cached overview, including a private note", async () => {
    const { server, options } = await fixture();
    expect((await operate(server, "create-private-note", "write", { key: "note", value: { text: "PRIVATE-NOTE-VALUE" }, expectedRevision: 1 })).status).toBe(200);
    const first = await operate(server, "overview-metadata", "snapshot");
    const oldSkeleton = { tenantId: "reference", worldId: "ordinary-world", revision: 2,
      records: [{ key: "initial-machine-target", revision: 1, value: { contents: Buffer.from(targetContents).toString("base64") } },
        { key: "note", revision: 2, value: "PRIVATE-NOTE-VALUE" }] };
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"));
    try { db.prepare("UPDATE requests SET response=? WHERE id='overview-metadata'").run(JSON.stringify(oldSkeleton)); }
    finally { db.close(); }
    const replay = await operate(server, "overview-metadata", "snapshot");
    expect(replay).toEqual(first);
    expect(first.body.records).toEqual([
      { key: "initial-machine-target", revision: 1, classification: "RESTRICTED", status: "AVAILABLE" },
      { key: "note", revision: 2, classification: "INTERNAL", status: "AVAILABLE" }
    ]);
    expect(JSON.stringify(first)).not.toContain("PRIVATE-NOTE-VALUE");
    expect(JSON.stringify(first)).not.toContain(Buffer.from(targetContents).toString("base64"));
    expect(server.report().targetReadCount).toBe(0);
  });

  it("binds role, tenant, principal, resource and tickets at the source even after a cached response", async () => {
    const restricted: FileOriginAccessPolicy = { tenantId: "tenant_a", principalId: "reader_a", readTarget: false,
      readOtherRecords: true, writeOtherRecords: true, issueTickets: true };
    const { server } = await fixture(undefined, restricted);
    const note = await operate(server, "safe-note", "write", { key: "note", value: { text: "PUBLIC-NOTE" }, expectedRevision: 1 });
    expect(note.status).toBe(200);
    const overview = await operate(server, "restricted-overview", "snapshot");
    expect(overview.status).toBe(200);
    expect(JSON.stringify(overview)).not.toContain("PUBLIC-NOTE");
    expect((await operate(server, "forged-admin", "read", { key: "initial-machine-target" }, normalToken,
      { role: "super_admin", tenantId: "tenant_a", principalId: "reader_a" })).body.error?.code).toBe("ORIGIN_SCOPE_DENIED");
    expect((await operate(server, "cross-tenant", "read", { key: "initial-machine-target" }, normalToken,
      { role: "admin", tenantId: "tenant_b" })).body.error?.code).toBe("ORIGIN_TENANT_DENIED");
    expect((await operate(server, "forged-principal", "read", { key: "initial-machine-target" }, normalToken,
      { principalId: "owner" })).body.error?.code).toBe("ORIGIN_PRINCIPAL_DENIED");
    expect((await operate(server, "target-ticket", "issue-ticket", { scope: ["initial-machine-target"] })).body.error?.code)
      .toBe("ORIGIN_SCOPE_DENIED");
    const noteTicket = await operate(server, "note-ticket", "issue-ticket", { scope: ["note"] });
    expect(noteTicket.status).toBe(200);
    expect((await operate(server, "mixed-scope", "use-ticket", { ticket: noteTicket.body.ticket, key: "initial-machine-target" })).body.error?.code)
      .toBe("ORIGIN_SCOPE_DENIED");
    expect((await operate(server, "note-ticket-read", "use-ticket", { ticket: noteTicket.body.ticket, key: "note" })).status).toBe(200);
    expect(server.report().targetReadCount).toBe(0);
    const second = await fixture(undefined, { ...fullPolicy, tenantId: "tenant_b", principalId: "reader_b" });
    expect((await operate(second.server, "foreign-tenant-ticket", "use-ticket", { ticket: noteTicket.body.ticket, key: "initial-machine-target" })).body.error?.code)
      .toBe("TICKET_AUTHORITY_DENIED");
    expect(second.server.report().targetReadCount).toBe(0);
  });

  it("returns arbitrary artificial target bytes as explicitly encoded content", async () => {
    const root = await mkdtemp(join(tmpdir(), "eva-file-origin-binary-")); roots.push(root);
    await installHostLayout(root);
    const targetPath = join(root, dungeonqTargetRelativePath);
    const bytes = Buffer.from([0, 255, 0, 128, 17, 42]);
    await writeFile(targetPath, bytes, { mode: 0o600 });
    const server = await startFileOrigin({ targetPath, baseline: await captureTargetWitness(root), directory: join(root, "origin"), normalToken, witnessToken,
      accessPolicy: { tenantId: "reference", principalId: "ordinary-connector", readTarget: true,
        readOtherRecords: true, writeOtherRecords: true, issueTickets: true } });
    servers.push(server);
    const response = await operate(server, "binary-read", "read", { key: "initial-machine-target" });
    expect(response.status).toBe(200);
    expect((response.body.value as { contentEncoding: string; contents: string }).contentEncoding).toBe("base64");
    expect(Buffer.from((response.body.value as { contents: string }).contents, "base64")).toEqual(bytes);
    expect(server.report().targetReadCount).toBe(1);
  });

  it("reads the pinned file through ordinary business authorization and never persists target bytes or bearer credentials", async () => {
    const { server, options } = await fixture();
    const read = await operate(server, "read-1", "read", { key: "initial-machine-target" });
    expect(read).toEqual({ status: 200, body: { key: "initial-machine-target", value: { documentId: "initial-machine-target", classification: "RESTRICTED", status: "AVAILABLE", contentEncoding: "base64", contents: Buffer.from(targetContents).toString("base64") }, recordRevision: 1, revision: 1 } });
    const snapshot = await operate(server, "snapshot-1", "snapshot");
    expect(snapshot.body.records).toEqual([{ key: "initial-machine-target", revision: 1, classification: "RESTRICTED", status: "AVAILABLE" }]);
    expect(JSON.stringify(snapshot)).not.toContain(Buffer.from(targetContents).toString("base64"));
    const report = server.report();
    expect(report.stateDigest).toBe(options.baseline.sha256);
    expect(report.acceptedContexts).toEqual(["ordinary"]);
    expect(report.targetReadCount).toBe(1);
    expect(report.witnessReadCount).toBe(3);
    expect(report.targetReads.every(row => row.admission_seq !== null && row.state === "READ" && row.bytes_read === 1)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(targetContents);
    await server.close();
    for (const filename of await readdir(options.directory)) {
      const contents = (await readFile(join(options.directory, filename))).toString("utf8");
      expect(contents).not.toContain(targetContents);
      expect(contents).not.toContain(normalToken);
      expect(contents).not.toContain(witnessToken);
    }
    expect(await readFile(options.targetPath, "utf8")).toBe(targetContents);
  });

  it("rejects bad bearer, wrong contexts, world-only tickets and path/key injection before any target-content read", async () => {
    const { server } = await fixture();
    const badAuth = await operate(server, "bad-bearer", "read", { key: "initial-machine-target" }, "other-actor-bearer");
    expect(badAuth.status).toBe(403);
    expect((await operate(server, "bad-context", "read", { key: "initial-machine-target" }, normalToken, { contextId: "diverted" })).status).toBe(403);
    expect((await operate(server, "world-ticket", "use-ticket", { ticket: "dungeonq.wrong-ticket.world-only", key: "initial-machine-target" })).body.error?.code).toBe("TICKET_AUTHORITY_DENIED");
    expect((await operate(server, "bad-key", "read", { key: "../../important-secret" })).status).toBe(400);
    expect((await operate(server, "injected-path", "read", { key: "initial-machine-target", path: optionsPath() })).status).toBe(400);
    expect((await operate(server, "injected-shell", "snapshot", {}, normalToken, { shell: "cat target" })).status).toBe(400);
    expect((await operate(server, "immutable", "write", { key: "initial-machine-target", value: "overwrite", expectedRevision: 1 })).body.error?.code).toBe("TARGET_IMMUTABLE");
    const witness = await fetch(`${server.origin}/witness`, { headers: { authorization: `Bearer ${normalToken}` } });
    expect(witness.status).toBe(401);
    const report = server.report();
    expect(report.targetReadCount).toBe(0);
    expect(report.accepted).toBe(0);
    expect(report.rejected).toBe(8);
    expect(report.admissions.map(row => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(JSON.stringify(report)).not.toContain("other-actor-bearer");
  });

  it("persists passive notes, exact retries and revision conflicts across restarts", async () => {
    const { server, options } = await fixture();
    const first = await operate(server, "note-1", "write", { key: "note", value: { text: "人工記錄" }, expectedRevision: 1 });
    expect(first.status).toBe(200); expect(first.body.revision).toBe(2);
    expect(await operate(server, "note-1", "write", { key: "note", value: { text: "人工記錄" }, expectedRevision: 1 })).toEqual(first);
    expect(await operate(server, "note-1", "write", { expectedRevision: 1, value: { text: "人工記錄" }, key: "note" })).toEqual(first);
    expect((await operate(server, "note-1", "write", { key: "note", value: "different", expectedRevision: 2 })).body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await operate(server, "stale-write", "write", { key: "other", value: "no", expectedRevision: 1 })).body.error?.code).toBe("REVISION_CONFLICT");
    expect((await operate(server, "unsafe-write", "write", { key: "other", value: "https://external.invalid/exfil", expectedRevision: 2 })).body.error?.code).toBe("VALUE_NOT_PASSIVE");
    const snapshot = await operate(server, "before-restart", "snapshot");
    const before = server.report();
    const next = await restart(server, options);
    expect(await operate(next, "note-1", "write", { key: "note", value: { text: "人工記錄" }, expectedRevision: 1 })).toEqual(first);
    expect(await operate(next, "before-restart", "snapshot")).toEqual(snapshot);
    expect((await operate(next, "note-read", "read", { key: "note" })).body).toEqual({ key: "note", value: { text: "人工記錄" }, revision: 2, recordRevision: 2 });
    const after = next.report();
    expect(after.configDigest).toBe(before.configDigest);
    expect(after.stateDigest).toBe(before.stateDigest);
    expect(after.admissions.slice(0, before.highWater)).toEqual(before.admissions);
    expect(after.targetReadCount).toBe(0);
  });

  it("persists finite ticket uses, supports exact use retry without consuming twice, and never accepts foreign tickets", async () => {
    const { server, options } = await fixture();
    const issued = await operate(server, "ticket-1", "issue-ticket", { scope: ["initial-machine-target"], maxUses: 2 });
    expect(issued.status).toBe(200);
    const ticket = issued.body.ticket;
    expect(ticket).toMatch(/^FILE_ORIGIN_/u);
    const first = await operate(server, "use-1", "use-ticket", { ticket, key: "initial-machine-target" });
    expect(first.body.usesRemaining).toBe(1);
    expect(await operate(server, "use-1", "use-ticket", { ticket, key: "initial-machine-target" })).toEqual(first);
    const next = await restart(server, options);
    expect(await operate(next, "ticket-1", "issue-ticket", { scope: ["initial-machine-target"], maxUses: 2 })).toEqual(issued);
    expect(await operate(next, "use-1", "use-ticket", { ticket, key: "initial-machine-target" })).toEqual(first);
    expect((await operate(next, "use-2", "use-ticket", { ticket, key: "initial-machine-target" })).body.usesRemaining).toBe(0);
    expect((await operate(next, "use-3", "use-ticket", { ticket, key: "initial-machine-target" })).body.error?.code).toBe("TICKET_EXHAUSTED");
    expect(await operate(next, "use-1", "use-ticket", { ticket, key: "initial-machine-target" })).toEqual(first);
    expect(next.report().targetReadCount).toBe(5);
    const other = await fixture();
    expect((await operate(other.server, "foreign-ticket", "use-ticket", { ticket, key: "initial-machine-target" })).body.error?.code).toBe("TICKET_AUTHORITY_DENIED");
    expect(other.server.report().targetReadCount).toBe(0);
  });

  it("enforces ticket scope and expiry before opening target contents", async () => {
    const { server, options } = await fixture();
    await operate(server, "note", "write", { key: "note", value: "passive", expectedRevision: 1 });
    const issued = await operate(server, "ticket", "issue-ticket", { scope: ["note"], maxUses: 2 });
    expect((await operate(server, "scope-bypass", "use-ticket", { ticket: issued.body.ticket, key: "initial-machine-target" })).body.error?.code).toBe("TICKET_SCOPE_DENIED");
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"));
    db.prepare("UPDATE tickets SET expires=0").run(); db.close();
    expect((await operate(server, "expired", "use-ticket", { ticket: issued.body.ticket, key: "note" })).body.error?.code).toBe("TICKET_EXPIRED");
    expect(server.report().targetReadCount).toBe(0);
  });

  it("rejects a genuine DungeonQ world ticket before reading the target", async () => {
    const { server, root } = await fixture();
    const runtime = await import(new URL("../../../vendor/dungeonq-runtime/runtime/store.mjs", import.meta.url).href) as {
      openRuntimeStore(options: { path: string }): {
        registerContext(input: Record<string, unknown>): unknown;
        execute(input: Record<string, unknown>): Record<string, unknown>;
        close(): void;
      };
    };
    const world = runtime.openRuntimeStore({ path: join(root, "world", "runtime.sqlite") });
    try {
      world.registerContext({ contextId: "diverted", tenantId: "reference", worldId: "world", disposition: "DIVERT", token: "world-participant-token-0123456789abcdef" });
      const issued = world.execute({ contextId: "diverted", family: "http", requestId: "world-issue", operation: "issue-ticket", args: { scope: ["welcome"] } });
      expect(typeof issued.ticket).toBe("string");
      const attempt = await operate(server, "real-world-ticket", "use-ticket", { ticket: issued.ticket, key: "initial-machine-target" });
      expect(attempt.body.error?.code).toBe("TICKET_AUTHORITY_DENIED");
      expect(server.report().targetReadCount).toBe(0);
    } finally { world.close(); }
  });

  it("fails closed after target mutation and retains the durable failed read intent", async () => {
    const { server, options } = await fixture();
    await writeFile(options.targetPath, "CHANGED-ARTIFICIAL", { mode: 0o600 });
    const read = await operate(server, "changed-target", "read", { key: "initial-machine-target" });
    expect(read.body.error?.code).toBe("TARGET_CHANGED");
    expect(JSON.stringify(read)).not.toContain("CHANGED-ARTIFICIAL");
    expect(() => server.report()).toThrow("ORIGIN_WITNESS_UNAVAILABLE");
    await server.close();
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"), { readOnly: true });
    try {
      const admission = db.prepare("SELECT * FROM admissions").get();
      expect(admission).toMatchObject({ seq: 1, accepted: 1, request_id: "changed-target" });
      expect(db.prepare("SELECT * FROM access_intents WHERE purpose='BUSINESS'").get()).toMatchObject({ admission_seq: 1, state: "FAILED", bytes_read: 0, error: "TARGET_CHANGED" });
      expect(db.prepare("SELECT * FROM requests").get()).toMatchObject({ state: "FAILED", error: "TARGET_CHANGED" });
    } finally { db.close(); }
    await expect(startFileOrigin(options)).rejects.toThrow("ORIGIN_WITNESS_UNAVAILABLE");
  });

  it("records whether changed bytes were actually read before rejecting the target", async () => {
    const { server, options } = await fixture();
    await writeFile(options.targetPath, Buffer.alloc(options.baseline.sizeBytes, 65), { mode: 0o600 });
    await utimes(options.targetPath, options.baseline.modifiedAtMs / 1000, options.baseline.modifiedAtMs / 1000);
    expect((await operate(server, "changed-hash", "read", { key: "initial-machine-target" })).body.error?.code).toBe("TARGET_CHANGED");
    await server.close();
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"), { readOnly: true });
    try {
      const intent = db.prepare("SELECT * FROM access_intents WHERE purpose='BUSINESS'").get() as { state: string; bytes_read: number; error: string };
      expect(intent).toMatchObject({ state: "FAILED", error: "TARGET_CHANGED" });
      // Filesystems can round the restored mtime differently: pre-read metadata
      // rejection is 0, while a matching timestamp reaches the hash read as 1.
      expect([0, 1]).toContain(intent.bytes_read);
    } finally { db.close(); }
  });

  it.each(["symlink", "replace", "hardlink", "mode"])("rejects target %s changes without disclosing replacement bytes", async change => {
    const { server, options, root } = await fixture();
    const other = join(root, "unrelated.txt");
    await writeFile(other, "DO-NOT-READ-THIS", { mode: 0o600 });
    if (change === "symlink") { await unlink(options.targetPath); await symlink(other, options.targetPath); }
    else if (change === "replace") await rename(other, options.targetPath);
    else if (change === "hardlink") await link(options.targetPath, join(root, "target-alias"));
    else await chmod(options.targetPath, 0o644);
    const read = await operate(server, "replacement", "read", { key: "initial-machine-target" });
    expect(read.status).toBe(503); expect(read.body.error?.code).toBe("TARGET_CHANGED");
    expect(JSON.stringify(read)).not.toContain("DO-NOT-READ-THIS");
  });

  it("rejects witness storage interruption before target read and detects abandoned pending intentions on restart", async () => {
    const { server, options } = await fixture();
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"));
    db.prepare("INSERT INTO access_intents(purpose,request_id,state) VALUES('BUSINESS','crash-before-read','PENDING')").run(); db.close();
    expect((await operate(server, "after-crash", "read", { key: "initial-machine-target" })).body.error?.code).toBe("ORIGIN_AUDIT_INCOMPLETE");
    expect(() => server.report()).toThrow("ORIGIN_AUDIT_INCOMPLETE");
    await server.close();
    await expect(startFileOrigin(options)).rejects.toThrow("ORIGIN_AUDIT_INCOMPLETE");
  });

  it("refuses new reads when an admission census is incomplete and sanitizes startup filesystem errors", async () => {
    const { server, options, root } = await fixture();
    await operate(server, "bad-1", "snapshot", {}, "invalid-auth-token");
    await operate(server, "bad-2", "snapshot", {}, "invalid-auth-token");
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"));
    db.prepare("DELETE FROM admissions WHERE seq=1").run(); db.close();
    expect((await operate(server, "after-gap", "read", { key: "initial-machine-target" })).body.error?.code).toBe("ORIGIN_AUDIT_INCOMPLETE");
    const readback = new DatabaseSync(join(options.directory, "file-origin.sqlite"), { readOnly: true });
    try { expect(readback.prepare("SELECT count(*) AS n FROM access_intents WHERE purpose='BUSINESS'").get()).toMatchObject({ n: 0 }); }
    finally { readback.close(); }
    await expect(startFileOrigin({ ...options, targetPath: join(root, "nonexistent-sensitive-directory", dungeonqTargetRelativePath) })).rejects.toThrow(/^FILE_ORIGIN_UNAVAILABLE$/u);
  });

  it("pins witness storage identity and refuses arbitrary startup paths or credential drift", async () => {
    const { server, options, root } = await fixture();
    await expect(startFileOrigin({ ...options, targetPath: join(root, "important-password.txt") })).rejects.toThrow("HOST_PATH_NOT_ALLOWLISTED");
    await expect(startFileOrigin(options)).rejects.toThrow("ORIGIN_STORAGE_LOCKED");
    await server.close();
    await expect(startFileOrigin({ ...options, normalToken: "changed-authentication-token" })).rejects.toThrow("ORIGIN_CONFIG_CHANGED");
    const next = await startFileOrigin(options); servers.push(next);
    await rename(join(options.directory, "file-origin.sqlite"), join(options.directory, "preserved.sqlite"));
    const read = await operate(next, "storage-changed", "read", { key: "initial-machine-target" });
    expect(read.status).toBe(503);
    expect(() => next.report()).toThrow();
  });
});

function optionsPath(): string { return "/forbidden/secret.txt"; }


describe("File origin optional credential rotation", () => {
  const control = "synthetic-rotation-control-token";
  const nextToken = "synthetic-next-business-token";
  async function controlRequest(server: FileOrigin, path: string, body?: unknown, token = control) {
    const response = await fetch(`${server.origin}/control/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  it("atomically rotates durable credentials, fences replay and tickets, and retains audited idempotent receipts", async () => {
    const { server, options } = await fixture(control);
    const before = server.report();
    const readArgs = { key: "initial-machine-target" };
    expect((await operate(server, "old-read", "read", readArgs)).status).toBe(200);
    const issued = await operate(server, "old-issue", "issue-ticket", { maxUses: 2 });
    const ticket = issued.body.ticket;
    expect((await operate(server, "old-use", "use-ticket", { ticket })).status).toBe(200);
    expect((await controlRequest(server, "status", undefined, normalToken)).status).toBe(401);
    const rotation = { actionId: "rotate-one", expectedEpoch: 0, nextToken };
    expect((await controlRequest(server, "rotate", rotation, witnessToken)).status).toBe(401);
    expect((await controlRequest(server, "rotate", { ...rotation, extra: true })).status).toBe(400);
    for (const forbidden of [normalToken, witnessToken, control]) {
      expect((await controlRequest(server, "rotate", { ...rotation, nextToken: forbidden })).status).toBe(403);
    }
    const rotated = await controlRequest(server, "rotate", rotation);
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ actionId: "rotate-one", previousEpoch: 0, epoch: 1 });
    expect(typeof rotated.body.monotonicNs).toBe("string");
    expect(await controlRequest(server, "rotate", rotation)).toEqual(rotated);
    expect((await controlRequest(server, "rotate", { ...rotation, nextToken: "synthetic-different-next-token" })).status).toBe(409);
    expect((await controlRequest(server, "rotate", { ...rotation, actionId: "stale-action" })).status).toBe(409);
    for (const operation of ["read", "snapshot", "use-ticket"]) {
      expect((await operate(server, `denied-${operation}`, operation, operation === "read" ? readArgs : operation === "use-ticket" ? { ticket } : {})).status).toBe(403);
    }
    expect((await operate(server, "control-as-business", "snapshot", {}, control)).status).toBe(403);
    expect((await operate(server, "fresh-read", "read", readArgs, nextToken)).status).toBe(200);
    for (const [requestId, operation, args] of [["old-read", "read", readArgs], ["old-issue", "issue-ticket", { maxUses: 2 }], ["old-use", "use-ticket", { ticket }]] as const) {
      expect((await operate(server, requestId, operation, args, nextToken)).body.error?.code).toBe("REQUEST_EPOCH_DENIED");
    }
    expect((await operate(server, "fresh-old-ticket", "use-ticket", { ticket }, nextToken)).body.error?.code).toBe("TICKET_AUTHORITY_DENIED");
    const freshTicket = await operate(server, "fresh-issue", "issue-ticket", {}, nextToken);
    expect((await operate(server, "fresh-use", "use-ticket", { ticket: freshTicket.body.ticket }, nextToken)).status).toBe(200);
    const status = await controlRequest(server, "status");
    expect(status.body).toEqual({ epoch: 1, rotations: [rotated.body] });
    expect(JSON.stringify(status)).not.toContain(nextToken);
    const after = server.report();
    expect(after.credentialEpoch).toBe(1);
    expect(after.configDigest).toBe(before.configDigest);
    expect(after.stateDigest).toBe(before.stateDigest);
    const restarted = await restart(server, options);
    expect((await operate(restarted, "restart-old", "read", readArgs)).status).toBe(403);
    expect((await operate(restarted, "restart-new", "read", readArgs, nextToken)).status).toBe(200);
    expect(await controlRequest(restarted, "rotate", rotation)).toEqual(rotated);
    expect((await controlRequest(restarted, "rotate", { actionId: "rotate-two", expectedEpoch: 1, nextToken: "synthetic-third-business-token" })).status).toBe(200);
    expect((await controlRequest(restarted, "rotate", { actionId: "reuse-history", expectedEpoch: 2, nextToken })).status).toBe(403);
    await restarted.close();
    for (const filename of await readdir(options.directory)) {
      const contents = (await readFile(join(options.directory, filename))).toString("utf8");
      for (const token of [normalToken, witnessToken, control, nextToken]) expect(contents).not.toContain(token);
    }
    const db = new DatabaseSync(join(options.directory, "file-origin.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM requests WHERE id IN ('old-read','old-issue','old-use')").get()).toMatchObject({ n: 3 });
      expect(db.prepare("SELECT count(*) AS n FROM tickets").get()).toMatchObject({ n: 2 });
    } finally { db.close(); }
    await expect(startFileOrigin({ ...options, rotationControlToken: undefined })).rejects.toThrow("ORIGIN_SCHEMA_CHANGED");
  });
  it("keeps default schema and behavior and refuses implicit conversion of old databases", async () => {
    const { server, options } = await fixture();
    expect(server.report()).not.toHaveProperty("credentialEpoch");
    expect((await controlRequest(server, "status")).status).toBe(400);
    await server.close();
    await expect(startFileOrigin({ ...options, rotationControlToken: control })).rejects.toThrow("ORIGIN_SCHEMA_CHANGED");
    const restarted = await restart(server, options);
    expect((await operate(restarted, "default-read", "read", { key: "initial-machine-target" })).status).toBe(200);
  });
});
