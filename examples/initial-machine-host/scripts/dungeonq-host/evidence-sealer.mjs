#!/usr/bin/env node
// DungeonQ 證據封存程序（R2）。
// 以獨立程序執行，模擬「欺敵主機以外的信任域」：只有本程序持有 Ed25519 私鑰；以唯讀方式讀資料庫的 journal head；
// 把簽好的檢查點只追加寫到自己的目錄；再把檢查點提交到錨點 Git 倉庫，有 remote 時推送並讀回。
// 重複執行的上限：封存間隔、每次執行的次數與總時間、推送重試（間隔逐次拉長，最多 3 次），任何不可用都停止。
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareJournalToCheckpoints, createCheckpoint, EvidenceSealError, publicKeyId, readJournalReadOnly,
  recomputeJournalChain, signCheckpoint, verifyCheckpointLog } from '../../vendor/dungeonq-runtime/runtime/evidence-seal.mjs';
import { worldDigest } from '../../vendor/dungeonq-runtime/world/kernel.mjs';

export const SEAL_PRIVATE_KEY = 'seal-ed25519.key';
export const SEAL_PUBLIC_KEY = 'seal-ed25519.pub';
export const CHECKPOINT_LOG = 'checkpoints.jsonl';
export const SEALER_LOG = 'sealer-log.jsonl';
export const SEALER_LOCK = 'sealer.lock';
export const ANCHOR_DIRECTORY = 'dungeonq-evidence';
export const anchorRelativePath = keyId => `${ANCHOR_DIRECTORY}/${keyId.slice(0, 16)}.jsonl`;
// M7 事後流程：事件證據 manifest 的簽章聲明（attestation），與檢查點用同一把封存金鑰、不同簽章網域，錨定在另一個只追加檔。
export const MANIFEST_ATTESTATION_SCHEMA = 'dungeonq.incident-manifest-attestation/v1';
export const MANIFEST_ATTESTATION_LOG = 'manifest-attestations.jsonl';
export const MANIFEST_ATTESTATION_KINDS = Object.freeze(['EVIDENCE', 'CLOSE_RECORD']);
export const manifestAnchorRelativePath = keyId => `${ANCHOR_DIRECTORY}/manifests/${keyId.slice(0, 16)}.jsonl`;
const MANIFEST_SIGNATURE_DOMAIN = 'dungeonq-incident-manifest-attestation-v1';
const ATTESTATION_KEYS = ['schemaVersion', 'keyId', 'index', 'previousAttestationDigest', 'incidentId', 'kind', 'manifestDigest',
  'journalSequence', 'journalHead', 'checkpointIndex', 'checkpointDigest', 'attestedAt'];
const HEX64 = /^[a-f0-9]{64}$/u;
const INCIDENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const EXIT_CODES = Object.freeze({ OK: 0, USAGE: 2, DATABASE: 3, ANCHOR: 4, PUSH: 5, TAMPER: 6, SEAL: 7 });
export const DEFAULTS = Object.freeze({ intervalMs: 60_000, maxCycles: 120, maxRunMs: 7_200_000, pushRetries: 3, pushBackoffMs: 2_000,
  gitTimeoutMs: 30_000, dbTimeoutMs: 2_000, remote: null, label: null });
const LIMITS = Object.freeze({ intervalMs: [50, 86_400_000], maxCycles: [1, 10_000], maxRunMs: [100, 86_400_000], pushRetries: [0, 3],
  pushBackoffMs: [1, 60_000], gitTimeoutMs: [100, 120_000], dbTimeoutMs: [0, 60_000] });
const CONFIG_KEYS = ['db', 'sealDir', 'anchorRepo', ...Object.keys(DEFAULTS)];
const COMMITTER = ['-c', 'user.name=dungeonq-evidence-sealer', '-c', 'user.email=evidence-sealer@localhost.invalid', '-c', 'commit.gpgsign=false'];
const MESSAGES = Object.freeze({
  LOCAL_ONLY: '未外送，只是同機錨定：錨點倉庫沒有 remote，證據完整性標為「同機自證」。',
  PUSHED_SAME_HOST: '已推送並讀回，但 remote 指向本機路徑，仍是同機錨定；證據完整性標為「同機自證」。',
  PUSHED: '已推送到 remote，並讀回遠端分支指向本次提交。',
  PUSH_FAILED: '推送失敗，檢查點只留在本機錨點倉庫；證據完整性標為「同機自證」。',
});

export class SealerStop extends Error {
  constructor(code, exitCode, detail) { super(code); this.name = 'SealerStop'; this.code = code; this.exitCode = exitCode; if (detail !== undefined) this.detail = detail; }
}
const stop = (code, exitCode, detail) => { throw new SealerStop(code, exitCode, detail); };
const insist = (condition, code, exitCode, detail) => { if (!condition) stop(code, exitCode, detail); };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => String(text ?? '').replace(/\/\/[^/@\s]+@/gu, '//***@').slice(0, 600);

function evidenceExit(code) {
  if (code.startsWith('DATABASE_')) return EXIT_CODES.DATABASE;
  if (['JOURNAL_CHAIN_BROKEN', 'JOURNAL_REWRITTEN', 'JOURNAL_TRUNCATED', 'STORE_MISMATCH'].includes(code)) return EXIT_CODES.TAMPER;
  return EXIT_CODES.SEAL;
}
function translate(error) {
  if (error instanceof SealerStop) return error;
  if (error instanceof EvidenceSealError) return new SealerStop(error.code, evidenceExit(error.code), error.detail);
  return new SealerStop('SEALER_INTERNAL_ERROR', EXIT_CODES.SEAL, { message: String(error?.message ?? error) });
}

/** Strict configuration: CLI flags override an optional JSON file; unknown keys and out-of-range bounds are rejected. */
export function resolveConfig(input) {
  insist(input && typeof input === 'object' && !Array.isArray(input), 'CONFIG_INVALID', EXIT_CODES.USAGE);
  for (const key of Object.keys(input)) insist(CONFIG_KEYS.includes(key), 'CONFIG_INVALID', EXIT_CODES.USAGE, { key });
  const config = { ...DEFAULTS, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
  for (const key of ['db', 'sealDir', 'anchorRepo']) insist(typeof config[key] === 'string' && isAbsolute(config[key]), 'CONFIG_INVALID', EXIT_CODES.USAGE, { key });
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    insist(Number.isSafeInteger(config[key]) && config[key] >= min && config[key] <= max, 'CONFIG_INVALID', EXIT_CODES.USAGE, { key, min, max });
  }
  insist(config.remote === null || (typeof config.remote === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(config.remote)), 'CONFIG_INVALID', EXIT_CODES.USAGE, { key: 'remote' });
  insist(config.label === null || (typeof config.label === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(config.label)), 'CONFIG_INVALID', EXIT_CODES.USAGE, { key: 'label' });
  return Object.freeze(config);
}

function privateDirectory(path) {
  let stat; try { stat = lstatSync(path); } catch { stop('SEAL_DIR_UNAVAILABLE', EXIT_CODES.SEAL); }
  insist(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'SEAL_DIR_NOT_PRIVATE', EXIT_CODES.SEAL);
  return realpathSync(path);
}
function readPrivateFile(path, code, maxBytes = 4096) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { stop(code, EXIT_CODES.SEAL); }
  try {
    const stat = fstatSync(descriptor);
    insist(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= maxBytes, code, EXIT_CODES.SEAL);
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}
function appendDurable(path, value) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function readJsonLines(path, code) {
  if (!existsSync(path)) return [];
  const text = readPrivateFile(path, code, 64 * 1024 * 1024);
  insist(text === '' || text.endsWith('\n'), code, EXIT_CODES.SEAL, { reason: 'PARTIAL_LINE' });
  try { return text.split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { stop(code, EXIT_CODES.SEAL, { reason: 'UNPARSEABLE' }); }
}

/** Generates the sealer's Ed25519 key pair in a new private directory. Never overwrites an existing key. */
export function generateSealKey(sealDir) {
  insist(typeof sealDir === 'string' && isAbsolute(sealDir), 'CONFIG_INVALID', EXIT_CODES.USAGE, { key: 'sealDir' });
  mkdirSync(sealDir, { recursive: true, mode: 0o700 }); privateDirectory(sealDir);
  const privatePath = join(sealDir, SEAL_PRIVATE_KEY); const publicPath = join(sealDir, SEAL_PUBLIC_KEY);
  insist(!existsSync(privatePath) && !existsSync(publicPath), 'SEAL_KEY_EXISTS', EXIT_CODES.SEAL);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600, flush: true });
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644, flush: true });
  return { keyId: publicKeyId(publicKey), publicKeyPath: publicPath };
}
function loadSealKey(sealDir) {
  let privateKey;
  try { privateKey = createPrivateKey(readPrivateFile(join(sealDir, SEAL_PRIVATE_KEY), 'SEAL_KEY_NOT_PRIVATE')); }
  catch (error) { if (error instanceof SealerStop) throw error; stop('SEAL_KEY_INVALID', EXIT_CODES.SEAL); }
  insist(privateKey.asymmetricKeyType === 'ed25519', 'SEAL_KEY_INVALID', EXIT_CODES.SEAL);
  const publicKey = createPublicKey(privateKey); const keyId = publicKeyId(publicKey);
  let stored; try { stored = publicKeyId(readFileSync(join(sealDir, SEAL_PUBLIC_KEY), 'utf8')); } catch { stored = null; }
  insist(stored === keyId, 'SEAL_PUBLIC_KEY_MISMATCH', EXIT_CODES.SEAL);
  return { privateKey, publicKey, keyId };
}
function acquireLock(sealDir) {
  const path = join(sealDir, SEALER_LOCK); const body = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, body, { flag: 'wx', mode: 0o600 }); return () => { try { if (readFileSync(path, 'utf8') === body) rmSync(path); } catch { /* already gone */ } }; }
    catch (error) {
      if (error.code !== 'EEXIST') stop('SEAL_DIR_UNAVAILABLE', EXIT_CODES.SEAL);
      let pid = null; try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { /* unreadable lock is treated as stale */ }
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (probe) { alive = probe.code === 'EPERM'; } }
      insist(!alive, 'SEALER_ALREADY_RUNNING', EXIT_CODES.SEAL, { pid });
      rmSync(path, { force: true });
    }
  }
  stop('SEALER_ALREADY_RUNNING', EXIT_CODES.SEAL);
}

/** Runs git without prompts or repository hooks, with a hard timeout. */
export function git(repo, args, { timeoutMs = DEFAULTS.gitTimeoutMs, extra = [] } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...extra, ...args], { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8', killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
    });
  });
}
/** The anchor path must be the root of its own work tree (never a folder inside another repository) on a named branch. */
export async function inspectAnchorRepo(anchorRepo, timeoutMs) {
  let real; try { real = realpathSync(anchorRepo); } catch { stop('ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'MISSING' }); }
  let top; try { top = (await git(real, ['rev-parse', '--show-toplevel'], { timeoutMs })).trim(); }
  catch { stop('ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'NOT_A_WORK_TREE' }); }
  insist(realpathSync(top) === real, 'ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'NOT_REPOSITORY_ROOT' });
  let branch; try { branch = (await git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs })).trim(); }
  catch { stop('ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'DETACHED_HEAD' }); }
  return { root: real, branch };
}
export const isLocalRemote = url => /^(?:\/|\.{1,2}\/|file:|~)/u.test(url) || /^[A-Za-z]:[\\/]/u.test(url);
/** Reads an anchor file from a commit. A missing commit or file is an empty anchor. */
export async function readAnchorAt(repo, ref, relativePath, timeoutMs) {
  try { await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeoutMs }); } catch { return { exists: false, text: '' }; }
  const listed = (await git(repo, ['ls-tree', '--name-only', ref, '--', relativePath], { timeoutMs })).trim();
  if (!listed) return { exists: false, text: '' };
  return { exists: true, text: await git(repo, ['show', `${ref}:${relativePath}`], { timeoutMs }) };
}
const parseAnchor = text => {
  try { return text.split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { stop('ANCHOR_CONFLICT', EXIT_CODES.ANCHOR, { reason: 'UNPARSEABLE' }); }
};

async function openSealer(config) {
  const sealDir = privateDirectory(config.sealDir);
  let dbDirectory; try { dbDirectory = realpathSync(dirname(config.db)); } catch { stop('DATABASE_UNAVAILABLE', EXIT_CODES.DATABASE); }
  let anchorReal; try { anchorReal = realpathSync(config.anchorRepo); } catch { stop('ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'MISSING' }); }
  // The private key, the database and the anchor must live in three separate places.
  insist(!inside(sealDir, dbDirectory) && !inside(dbDirectory, sealDir), 'SEAL_DIR_NOT_SEPARATE', EXIT_CODES.USAGE);
  insist(!inside(anchorReal, sealDir) && !inside(sealDir, anchorReal), 'SEAL_DIR_NOT_SEPARATE', EXIT_CODES.USAGE);
  insist(!inside(anchorReal, dbDirectory) && !inside(dbDirectory, anchorReal), 'ANCHOR_REPO_NOT_SEPARATE', EXIT_CODES.USAGE);
  const key = loadSealKey(sealDir); const release = acquireLock(sealDir);
  try {
    const checkpointPath = join(sealDir, CHECKPOINT_LOG); const log = readJsonLines(checkpointPath, 'SEAL_LOG_INVALID');
    const verified = verifyCheckpointLog(log, key.publicKey);
    insist(verified.status === 'VALID', 'SEAL_LOG_INVALID', EXIT_CODES.SEAL, verified.firstProblem);
    const anchor = await inspectAnchorRepo(anchorReal, config.gitTimeoutMs);
    return { config, sealDir, key, log, checkpointPath, sealerLogPath: join(sealDir, SEALER_LOG), anchor,
      anchorPath: anchorRelativePath(key.keyId), release };
  } catch (error) { release(); throw error; }
}

/** Commits every signed checkpoint not yet in the anchor file, in order, as one append-only commit. */
function anchorPending(context) {
  return anchorEntries(context, context.anchorPath, context.log,
    last => `DungeonQ 證據檢查點 #${last.index}（序號 ${last.sequence}，${last.digest.slice(0, 16)}）`);
}
/** Generic append-only anchoring of a signed log (checkpoints or manifest attestations) into one anchor file. */
async function anchorEntries(context, anchorPath, log, message) {
  const { config, anchor } = context; const timeoutMs = config.gitTimeoutMs;
  const current = await readAnchorAt(anchor.root, 'HEAD', anchorPath, timeoutMs);
  insist(current.text === '' || current.text.endsWith('\n'), 'ANCHOR_CONFLICT', EXIT_CODES.ANCHOR, { reason: 'PARTIAL_LINE' });
  const anchored = parseAnchor(current.text);
  insist(anchored.length <= log.length && anchored.every((entry, index) => entry?.digest === log[index].digest),
    'ANCHOR_CONFLICT', EXIT_CODES.ANCHOR, { anchored: anchored.length, sealed: log.length });
  const pending = log.slice(anchored.length);
  if (!pending.length) return { committed: false, anchoredCount: anchored.length, pendingCount: 0 };
  const target = join(anchor.root, anchorPath); const temporary = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    insist(!lstatSync(dirname(target)).isSymbolicLink(), 'ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'SYMLINK' });
    if (existsSync(target)) insist(lstatSync(target).isFile(), 'ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'NOT_A_FILE' });
    writeFileSync(temporary, current.text + pending.map(entry => `${JSON.stringify(entry)}\n`).join(''), { flag: 'wx', mode: 0o644, flush: true });
    renameSync(temporary, target);
    await git(anchor.root, ['add', '--', anchorPath], { timeoutMs });
    const last = pending.at(-1);
    await git(anchor.root, ['commit', '--no-verify', '--quiet', '-m', message(last), '--', anchorPath], { timeoutMs, extra: COMMITTER });
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof SealerStop) throw error;
    stop('ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'COMMIT_FAILED', message: redact(error.stderr || error.message) });
  }
  const readBack = parseAnchor((await readAnchorAt(anchor.root, 'HEAD', anchorPath, timeoutMs)).text);
  insist(readBack.length === log.length && readBack.at(-1)?.digest === log.at(-1).digest, 'ANCHOR_UNAVAILABLE', EXIT_CODES.ANCHOR, { reason: 'READBACK_MISMATCH' });
  const commit = (await git(anchor.root, ['rev-parse', 'HEAD'], { timeoutMs })).trim();
  return { committed: true, commit, anchoredCount: log.length, pendingCount: pending.length };
}

/** Pushes the anchor branch when a remote exists; retries at most pushRetries times with doubling delays, then stops. */
async function pushAnchor(context, record) {
  const { config, anchor } = context; const timeoutMs = config.gitTimeoutMs;
  const remotes = (await git(anchor.root, ['remote'], { timeoutMs })).split('\n').map(line => line.trim()).filter(Boolean);
  if (!remotes.length) return { mode: 'LOCAL_ONLY', external: false, message: MESSAGES.LOCAL_ONLY };
  let remote = config.remote;
  if (remote) insist(remotes.includes(remote), 'ANCHOR_REMOTE_UNKNOWN', EXIT_CODES.ANCHOR, { remote });
  else remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : stop('ANCHOR_REMOTE_AMBIGUOUS', EXIT_CODES.ANCHOR, { remotes });
  const url = (await git(anchor.root, ['remote', 'get-url', remote], { timeoutMs })).trim(); const sameHost = isLocalRemote(url);
  const commit = (await git(anchor.root, ['rev-parse', 'HEAD'], { timeoutMs })).trim(); const attempts = [];
  for (let attempt = 0; attempt <= config.pushRetries; attempt++) {
    const waitMs = attempt === 0 ? 0 : config.pushBackoffMs * 2 ** (attempt - 1);
    if (waitMs) await delay(waitMs);
    try {
      await git(anchor.root, ['push', '--no-verify', '--quiet', remote, `HEAD:refs/heads/${anchor.branch}`], { timeoutMs });
      const remoteHead = (await git(anchor.root, ['ls-remote', remote, `refs/heads/${anchor.branch}`], { timeoutMs })).split(/\s+/u)[0];
      if (remoteHead !== commit) throw Object.assign(new Error('READBACK_MISMATCH'), { stderr: 'remote branch does not point to the anchor commit' });
      attempts.push({ attempt: attempt + 1, waitMs, outcome: 'PUSHED' });
      const mode = sameHost ? 'PUSHED_SAME_HOST' : 'PUSHED';
      return { mode, external: !sameHost, remote, branch: anchor.branch, commit, attempts, message: MESSAGES[mode] };
    } catch (error) {
      attempts.push({ attempt: attempt + 1, waitMs, outcome: 'FAILED', message: redact(error.stderr || error.message) });
      record({ event: 'PUSH_ATTEMPT_FAILED', remote, attempt: attempt + 1, maxAttempts: config.pushRetries + 1, waitMs });
    }
  }
  stop('PUSH_FAILED', EXIT_CODES.PUSH, { mode: 'PUSH_FAILED', external: false, remote, commit, attempts, message: MESSAGES.PUSH_FAILED });
}

/** One sealing step: read the head read-only, refuse if sealed history changed, sign, append, anchor, push. */
async function sealOnce(context, reason, record, now) {
  const { config, key, log } = context;
  const snapshot = readJournalReadOnly(config.db, { timeoutMs: config.dbTimeoutMs });
  const chain = recomputeJournalChain(snapshot);
  insist(chain.status === 'LINKED', 'JOURNAL_CHAIN_BROKEN', EXIT_CODES.TAMPER, chain.firstBreak);
  insist(chain.linkedThrough === 0 || snapshot.metaStateDigest === chain.stateDigest, 'STATE_DIGEST_MISMATCH', EXIT_CODES.TAMPER);
  if (log.length) {
    const comparison = compareJournalToCheckpoints({ genesis: snapshot.genesis, rows: snapshot.rows, checkpoints: log });
    insist(comparison.status === 'MATCH', 'TAMPER_DETECTED', EXIT_CODES.TAMPER, comparison.firstMismatch);
  }
  const previous = log.at(-1) ?? null;
  if (reason === 'PERIODIC' && previous && previous.sequence === chain.linkedThrough) {
    return { event: 'UNCHANGED', sequence: chain.linkedThrough, head: chain.head, message: '自上個檢查點後 journal 沒有新事件，本輪不簽章。' };
  }
  const sealedAt = Math.max(now(), previous?.sealedAt ?? 0);
  const signed = signCheckpoint(createCheckpoint({ chain, previous, keyId: key.keyId, storeLabel: config.label, sealedAt, reason }), key.privateKey);
  appendDurable(context.checkpointPath, signed); log.push(signed);
  const checkpoint = { index: signed.index, sequence: signed.sequence, head: signed.head, digest: signed.digest, reason };
  record({ event: 'CHECKPOINT_SIGNED', checkpoint, journalKeyMode: snapshot.journalKeyMode });
  const anchored = await anchorPending(context);
  const pushed = await pushAnchor(context, record);
  return { event: 'SEALED', checkpoint, anchor: { ...anchored, ...pushed }, evidenceIntegrity: pushed.external ? 'EXTERNALLY_ANCHORED' : 'SAME_HOST_SELF_ATTESTED',
    message: pushed.message };
}

/**
 * Starts the sealer. mode 'once' seals one MANUAL checkpoint; mode 'run' seals every intervalMs until maxCycles or maxRunMs,
 * then (or on stop()) writes one FINAL checkpoint. Any unavailable database/anchor, push failure or detected rewrite halts it.
 */
export function startSealer(input, { mode = 'run', now = Date.now, onRecord = () => {} } = {}) {
  let stopReason = null; let wake = null; let context = null;
  const record = entry => {
    const line = { at: now(), ...entry };
    if (context) { try { appendDurable(context.sealerLogPath, line); } catch { /* the stdout record still exists */ } }
    onRecord(line);
  };
  const stopSealer = reason => { if (!stopReason) stopReason = reason; wake?.(); };
  const done = (async () => {
    let cycles = 0;
    try {
      const config = resolveConfig(input);
      context = await openSealer(config);
      record({ event: 'STARTED', mode, keyId: context.key.keyId, anchorPath: context.anchorPath, checkpoints: context.log.length,
        limits: { intervalMs: config.intervalMs, maxCycles: config.maxCycles, maxRunMs: config.maxRunMs, pushRetries: config.pushRetries } });
      const reconciled = await anchorPending(context);
      if (reconciled.committed) {
        record({ event: 'ANCHOR_RECONCILED', ...reconciled });
        const pushed = await pushAnchor(context, record); record({ event: 'ANCHOR_PUSH', ...pushed });
      }
      if (mode === 'once') {
        record(await sealOnce(context, 'MANUAL', record, now));
        record({ event: 'STOPPED', reason: 'ONCE', cycles: 1 });
        return { status: 'STOPPED', reason: 'ONCE', exitCode: EXIT_CODES.OK, cycles: 1 };
      }
      const deadline = now() + config.maxRunMs;
      while (!stopReason) {
        if (cycles >= config.maxCycles) { stopReason = 'MAX_CYCLES'; break; }
        if (now() >= deadline) { stopReason = 'MAX_RUN_TIME'; break; }
        cycles++; record({ ...(await sealOnce(context, 'PERIODIC', record, now)), cycle: cycles });
        if (stopReason || cycles >= config.maxCycles) continue;
        const waitMs = Math.max(0, Math.min(config.intervalMs, deadline - now()));
        await new Promise(resolve => { const timer = setTimeout(resolve, waitMs); wake = () => { clearTimeout(timer); resolve(); }; });
        wake = null;
      }
      record({ ...(await sealOnce(context, 'FINAL', record, now)), cycle: 'FINAL' });
      record({ event: 'STOPPED', reason: stopReason, cycles });
      return { status: 'STOPPED', reason: stopReason, exitCode: EXIT_CODES.OK, cycles };
    } catch (error) {
      const halt = translate(error);
      record({ event: 'HALTED', code: halt.code, exitCode: halt.exitCode, cycles, ...(halt.detail !== undefined ? { detail: halt.detail } : {}),
        evidenceIntegrity: 'SAME_HOST_SELF_ATTESTED', message: haltMessage(halt.code) });
      return { status: 'HALTED', code: halt.code, exitCode: halt.exitCode, cycles, detail: halt.detail };
    } finally { context?.release(); }
  })();
  return { stop: stopSealer, done };
}
/* ------------------------------------------------------------------ */
/* M7：事件證據 manifest 的簽章聲明                                      */
/* ------------------------------------------------------------------ */

const isHex64 = value => typeof value === 'string' && HEX64.test(value);
const exactBodyKeys = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === ATTESTATION_KEYS.length && ATTESTATION_KEYS.every(key => Object.hasOwn(value, key));
const attestationMessage = digest => Buffer.from(`${MANIFEST_SIGNATURE_DOMAIN}\0${digest}`);

function attestationBodyProblem(body) {
  if (!exactBodyKeys(body)) return 'ATTESTATION_ENVELOPE_INVALID';
  if (body.schemaVersion !== MANIFEST_ATTESTATION_SCHEMA) return 'ATTESTATION_SCHEMA_INVALID';
  if (!isHex64(body.keyId) || !isHex64(body.manifestDigest) || !isHex64(body.journalHead) || !isHex64(body.checkpointDigest)) return 'ATTESTATION_DIGEST_INVALID';
  if (typeof body.incidentId !== 'string' || !INCIDENT_ID.test(body.incidentId)) return 'ATTESTATION_INCIDENT_INVALID';
  if (!MANIFEST_ATTESTATION_KINDS.includes(body.kind)) return 'ATTESTATION_KIND_INVALID';
  if (![body.index, body.journalSequence, body.checkpointIndex, body.attestedAt].every(value => Number.isSafeInteger(value) && value >= 0)) return 'ATTESTATION_NUMBER_INVALID';
  if (body.index === 0 ? body.previousAttestationDigest !== null : !isHex64(body.previousAttestationDigest)) return 'ATTESTATION_LINK_INVALID';
  return null;
}

/** Signs a manifest attestation body with the sealer's Ed25519 key (domain separated from checkpoints). */
export function signManifestAttestation(body, privateKey) {
  const problem = attestationBodyProblem(body);
  if (problem) throw new SealerStop(problem, EXIT_CODES.SEAL);
  insist(privateKey instanceof KeyObject && privateKey.type === 'private' && body.keyId === publicKeyId(createPublicKey(privateKey)),
    'ATTESTATION_KEY_MISMATCH', EXIT_CODES.SEAL);
  const digest = worldDigest(body);
  return { ...structuredClone(body), digest, signature: sign(null, attestationMessage(digest), privateKey).toString('base64url') };
}

/** Verifies one manifest attestation with the public key only. */
export function verifyManifestAttestation(signed, publicKey) {
  let key;
  try { key = publicKey instanceof KeyObject ? publicKey : createPublicKey(publicKey); } catch { return { valid: false, reason: 'SEAL_PUBLIC_KEY_INVALID' }; }
  if (signed === null || typeof signed !== 'object' || Array.isArray(signed)) return { valid: false, reason: 'ATTESTATION_ENVELOPE_INVALID' };
  const { digest, signature, ...body } = signed;
  const problem = attestationBodyProblem(body);
  if (problem) return { valid: false, reason: problem };
  if (!isHex64(digest) || worldDigest(body) !== digest) return { valid: false, reason: 'ATTESTATION_DIGEST_MISMATCH' };
  if (body.keyId !== publicKeyId(key)) return { valid: false, reason: 'ATTESTATION_KEY_MISMATCH' };
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(signature)
    || !verify(null, attestationMessage(digest), key, Buffer.from(signature, 'base64url'))) return { valid: false, reason: 'ATTESTATION_SIGNATURE_INVALID' };
  return { valid: true };
}

/** Verifies an ordered attestation log: every signature, contiguous indexes and digest links, monotonic time. */
export function verifyManifestAttestationLog(entries, publicKey) {
  if (!Array.isArray(entries)) return { status: 'INVALID', count: 0, firstProblem: { index: 0, reason: 'ATTESTATION_LOG_INVALID' } };
  let previous = null;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]; const problem = reason => ({ status: 'INVALID', count: entries.length, firstProblem: { index, reason } });
    const single = verifyManifestAttestation(entry, publicKey);
    if (!single.valid) return problem(single.reason);
    if (entry.index !== index) return problem('ATTESTATION_INDEX_GAP');
    if (previous && (entry.previousAttestationDigest !== previous.digest)) return problem('ATTESTATION_LINK_MISMATCH');
    if (previous && entry.attestedAt < previous.attestedAt) return problem('ATTESTATION_TIME_INVALID');
    previous = entry;
  }
  return { status: 'VALID', count: entries.length, lastDigest: previous?.digest ?? null };
}

/** Finds the signed checkpoint whose event digests contain journal position `sequence` with digest `head`. */
export function findCoveringCheckpoint(checkpoints, sequence, head) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !isHex64(head)) return null;
  if (sequence === 0) return checkpoints.find(entry => entry.genesis === head) ?? null;
  return checkpoints.find(entry => entry.fromSequence < sequence && sequence <= entry.sequence
    && entry.eventDigests[sequence - entry.fromSequence - 1] === head) ?? null;
}

/**
 * Seals the journal once (MANUAL checkpoint), then signs an attestation that binds an incident manifest digest to the
 * signed checkpoint covering `journalSequence`/`journalHead`, appends it to the sealer directory and anchors it
 * append-only in the anchor repository (pushing when a remote exists). Never retries beyond the push limits; any
 * unavailable database or anchor, detected rewrite, or a journal head that is not covered halts without signing.
 */
export async function attestManifest(input, request, { now = Date.now, onRecord = () => {} } = {}) {
  let context = null;
  const record = entry => {
    const line = { at: now(), ...entry };
    if (context) { try { appendDurable(context.sealerLogPath, line); } catch { /* the returned record still exists */ } }
    onRecord(line);
  };
  try {
    insist(request && typeof request === 'object' && !Array.isArray(request)
      && Object.keys(request).every(key => ['incidentId', 'kind', 'manifestDigest', 'journalSequence', 'journalHead'].includes(key)),
    'ATTESTATION_REQUEST_INVALID', EXIT_CODES.USAGE);
    const { incidentId, kind, manifestDigest, journalSequence, journalHead } = request;
    insist(typeof incidentId === 'string' && INCIDENT_ID.test(incidentId) && MANIFEST_ATTESTATION_KINDS.includes(kind) && isHex64(manifestDigest)
      && Number.isSafeInteger(journalSequence) && journalSequence >= 0 && isHex64(journalHead), 'ATTESTATION_REQUEST_INVALID', EXIT_CODES.USAGE);
    const config = resolveConfig(input);
    context = await openSealer(config);
    const attestationPath = join(context.sealDir, MANIFEST_ATTESTATION_LOG);
    const attestations = readJsonLines(attestationPath, 'ATTESTATION_LOG_INVALID');
    const checked = verifyManifestAttestationLog(attestations, context.key.publicKey);
    insist(checked.status === 'VALID', 'ATTESTATION_LOG_INVALID', EXIT_CODES.SEAL, checked.firstProblem);
    const manifestPath = manifestAnchorRelativePath(context.key.keyId);
    const attestationMessageFor = last => `DungeonQ 事件 manifest 聲明 #${last.index}（${last.kind}，${last.manifestDigest.slice(0, 16)}）`;
    record({ event: 'ATTEST_STARTED', incidentId, kind, manifestDigest });
    await anchorPending(context); await anchorEntries(context, manifestPath, attestations, attestationMessageFor);
    const sealed = await sealOnce(context, 'MANUAL', record, now);
    record(sealed);
    const covering = findCoveringCheckpoint(context.log, journalSequence, journalHead);
    insist(covering, 'MANIFEST_JOURNAL_NOT_COVERED', EXIT_CODES.TAMPER, { journalSequence });
    const previous = attestations.at(-1) ?? null;
    const body = { schemaVersion: MANIFEST_ATTESTATION_SCHEMA, keyId: context.key.keyId, index: previous ? previous.index + 1 : 0,
      previousAttestationDigest: previous ? previous.digest : null, incidentId, kind, manifestDigest, journalSequence, journalHead,
      checkpointIndex: covering.index, checkpointDigest: covering.digest, attestedAt: Math.max(now(), previous?.attestedAt ?? 0) };
    const signed = signManifestAttestation(body, context.key.privateKey);
    appendDurable(attestationPath, signed); attestations.push(signed);
    const attestation = { index: signed.index, digest: signed.digest, incidentId, kind, manifestDigest,
      checkpointIndex: signed.checkpointIndex, checkpointDigest: signed.checkpointDigest };
    record({ event: 'MANIFEST_ATTESTED', attestation });
    const anchored = await anchorEntries(context, manifestPath, attestations, attestationMessageFor);
    const pushed = await pushAnchor(context, record);
    const evidenceIntegrity = pushed.external ? 'EXTERNALLY_ANCHORED' : 'SAME_HOST_SELF_ATTESTED';
    record({ event: 'ATTEST_ANCHORED', mode: pushed.mode, evidenceIntegrity });
    return { status: 'ATTESTED', exitCode: EXIT_CODES.OK, attestation, checkpoint: sealed.checkpoint, anchor: { ...anchored, ...pushed },
      evidenceIntegrity, message: pushed.message };
  } catch (error) {
    const halt = translate(error);
    record({ event: 'HALTED', code: halt.code, exitCode: halt.exitCode, ...(halt.detail !== undefined ? { detail: halt.detail } : {}),
      evidenceIntegrity: 'SAME_HOST_SELF_ATTESTED', message: haltMessage(halt.code) });
    return { status: 'HALTED', code: halt.code, exitCode: halt.exitCode, detail: halt.detail };
  } finally { context?.release(); }
}

function haltMessage(code) {
  if (code.startsWith('DATABASE_')) return '資料庫不可用或被鎖住，封存程序停止，不重試。';
  if (code.startsWith('ANCHOR_')) return '錨點倉庫不可用，封存程序停止；已簽的檢查點留在封存目錄，下次啟動會補錨定。';
  if (code === 'PUSH_FAILED') return MESSAGES.PUSH_FAILED;
  if (['TAMPER_DETECTED', 'JOURNAL_CHAIN_BROKEN', 'JOURNAL_REWRITTEN', 'JOURNAL_TRUNCATED', 'STORE_MISMATCH', 'STATE_DIGEST_MISMATCH'].includes(code)) {
    return '已簽章的 journal 歷史被改動，封存程序拒絕簽新的檢查點並停止。';
  }
  if (code === 'CONFIG_INVALID' || code.endsWith('NOT_SEPARATE')) return '設定不合格，封存程序沒有啟動。';
  return '封存程序停止。';
}

const USAGE = `用法：
  node scripts/dungeonq-host/evidence-sealer.mjs keygen --seal-dir <絕對路徑>
  node scripts/dungeonq-host/evidence-sealer.mjs once --db <絕對路徑> --seal-dir <絕對路徑> --anchor-repo <絕對路徑> [選項]
  node scripts/dungeonq-host/evidence-sealer.mjs run  --db <絕對路徑> --seal-dir <絕對路徑> --anchor-repo <絕對路徑> [選項]
選項：--config <JSON 檔> --label <名稱> --interval-ms <毫秒，預設 60000> --max-cycles <次數，預設 120>
      --max-run-ms <毫秒，預設 7200000> --push-retries <0-3，預設 3> --push-backoff-ms <毫秒，預設 2000>
      --git-timeout-ms <毫秒，預設 30000> --db-timeout-ms <毫秒，預設 2000> --remote <remote 名稱>
  node scripts/dungeonq-host/evidence-sealer.mjs attest --db <絕對路徑> --seal-dir <絕對路徑> --anchor-repo <絕對路徑>
      --incident-id <事件編號> --kind <EVIDENCE|CLOSE_RECORD> --manifest-digest <64 hex> --journal-sequence <整數> --journal-head <64 hex> [選項]
      先封存一次（MANUAL），再對事件 manifest 簽章並錨定（M7 事後流程）。`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = { config: { type: 'string' }, db: { type: 'string' }, 'seal-dir': { type: 'string' }, 'anchor-repo': { type: 'string' },
    label: { type: 'string' }, remote: { type: 'string' }, 'interval-ms': { type: 'string' }, 'max-cycles': { type: 'string' },
    'max-run-ms': { type: 'string' }, 'push-retries': { type: 'string' }, 'push-backoff-ms': { type: 'string' },
    'git-timeout-ms': { type: 'string' }, 'db-timeout-ms': { type: 'string' }, 'incident-id': { type: 'string' }, kind: { type: 'string' },
    'manifest-digest': { type: 'string' }, 'journal-sequence': { type: 'string' }, 'journal-head': { type: 'string' } };
  const print = line => process.stdout.write(`${JSON.stringify(line)}\n`);
  let values;
  try { ({ values } = parseArgs({ args: rest, options, strict: true, allowPositionals: false })); }
  catch { process.stderr.write(`${USAGE}\n`); return EXIT_CODES.USAGE; }
  if (command === 'keygen') {
    try { const result = generateSealKey(values['seal-dir']); print({ event: 'KEY_GENERATED', ...result, message: '已建立 Ed25519 金鑰；請經獨立管道把公鑰交給驗證端。' }); return EXIT_CODES.OK; }
    catch (error) { const halt = translate(error); print({ event: 'HALTED', code: halt.code }); return halt.exitCode; }
  }
  const attestKeys = ['incident-id', 'kind', 'manifest-digest', 'journal-sequence', 'journal-head'];
  if (!['once', 'run', 'attest'].includes(command) || (command !== 'attest' && attestKeys.some(key => values[key] !== undefined))) {
    process.stderr.write(`${USAGE}\n`); return EXIT_CODES.USAGE;
  }
  let fileConfig = {};
  if (values.config) {
    try { fileConfig = JSON.parse(readFileSync(values.config, 'utf8')); } catch { print({ event: 'HALTED', code: 'CONFIG_INVALID' }); return EXIT_CODES.USAGE; }
  }
  const number = name => values[name] === undefined ? undefined : /^\d+$/u.test(values[name]) ? Number(values[name]) : Number.NaN;
  const input = { ...fileConfig, ...Object.fromEntries(Object.entries({ db: values.db, sealDir: values['seal-dir'], anchorRepo: values['anchor-repo'],
    label: values.label, remote: values.remote, intervalMs: number('interval-ms'), maxCycles: number('max-cycles'), maxRunMs: number('max-run-ms'),
    pushRetries: number('push-retries'), pushBackoffMs: number('push-backoff-ms'), gitTimeoutMs: number('git-timeout-ms'),
    dbTimeoutMs: number('db-timeout-ms') }).filter(([, value]) => value !== undefined)) };
  if (command === 'attest') {
    const result = await attestManifest(input, { incidentId: values['incident-id'], kind: values.kind, manifestDigest: values['manifest-digest'],
      journalSequence: number('journal-sequence'), journalHead: values['journal-head'] }, { onRecord: print });
    return result.exitCode;
  }
  const sealer = startSealer(input, { mode: command, onRecord: print });
  let signals = 0;
  const onSignal = name => { signals++; if (signals > 1) process.exit(130); sealer.stop(name); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const result = await sealer.done;
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main();
