#!/usr/bin/env node
// DungeonQ 證據驗證器（R2）。只用公鑰與錨點 Git 倉庫，加上以唯讀方式讀取的資料庫，驗證 journal 證據鏈。
// 不需要也不讀取 ticket-key、journal key 或封存私鑰；不連網，remote 狀態只依本機已記錄的 remote-tracking ref 判斷。
import { createPublicKey } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareJournalToCheckpoints, EvidenceSealError, publicKeyId, readJournalReadOnly,
  verifyCheckpointLog } from '../../vendor/dungeonq-runtime/runtime/evidence-seal.mjs';
import { anchorRelativePath, findCoveringCheckpoint, git, inspectAnchorRepo, isLocalRemote, manifestAnchorRelativePath, readAnchorAt,
  SealerStop, verifyManifestAttestationLog } from './evidence-sealer.mjs';

export const VERIFY_EXIT_CODES = Object.freeze({ VERIFIED: 0, FAILED: 1, USAGE: 2, DATABASE: 3, ANCHOR: 4 });
const MAX_ANCHOR_COMMITS = 10_000;
const parseLines = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));

/** Walks every first-parent commit that touched the anchor file and requires each version to extend the previous one. */
async function readAnchorHistory(repo, ref, relativePath, timeoutMs) {
  let commits = [];
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeoutMs });
    commits = (await git(repo, ['log', '--first-parent', '--format=%H', '--reverse', ref, '--', relativePath], { timeoutMs }))
      .split('\n').filter(Boolean);
  } catch { return { commits: [], text: '', appendOnly: true }; }
  if (commits.length > MAX_ANCHOR_COMMITS) return { commits, text: '', appendOnly: false, problem: 'ANCHOR_HISTORY_TOO_LARGE' };
  let previous = '';
  for (const commit of commits) {
    const version = await readAnchorAt(repo, commit, relativePath, timeoutMs);
    if (!version.exists || !version.text.startsWith(previous) || !version.text.endsWith('\n')) {
      return { commits, text: version.text, appendOnly: false, problem: 'ANCHOR_NOT_APPEND_ONLY', commit };
    }
    previous = version.text;
  }
  return { commits, text: previous, appendOnly: true };
}

async function remoteStatus(repo, lastCommit, timeoutMs) {
  const remotes = (await git(repo, ['remote'], { timeoutMs })).split('\n').map(line => line.trim()).filter(Boolean);
  if (!remotes.length) return { status: 'NO_REMOTE', remotes: [] };
  if (!lastCommit) return { status: 'NOT_PUSHED', remotes };
  const containing = (await git(repo, ['branch', '-r', '--format=%(refname:short)', '--contains', lastCommit], { timeoutMs }))
    .split('\n').map(line => line.trim()).filter(Boolean);
  const details = [];
  for (const remote of remotes) {
    const url = (await git(repo, ['remote', 'get-url', remote], { timeoutMs })).trim();
    details.push({ remote, sameHost: isLocalRemote(url), contains: containing.some(ref => ref.startsWith(`${remote}/`)) });
  }
  if (details.some(item => item.contains && !item.sameHost)) return { status: 'RECORDED_PUSHED', remotes: details };
  if (details.some(item => item.contains)) return { status: 'SAME_HOST_REMOTE', remotes: details };
  return { status: 'NOT_PUSHED', remotes: details };
}

/** Verifies the database journal against signed, anchored checkpoints. Returns a report; never writes anything. */
export async function verifyEvidence({ db, publicKey, anchorRepo, ref = 'HEAD', sealLog, dbTimeoutMs = 2000, gitTimeoutMs = 30_000 }) {
  const findings = [];
  for (const [key, value] of Object.entries({ db, publicKey, anchorRepo })) {
    if (typeof value !== 'string' || !isAbsolute(value)) return { verdict: 'USAGE_ERROR', exitCode: VERIFY_EXIT_CODES.USAGE, key };
  }
  let key;
  try { key = createPublicKey(readFileSync(publicKey, 'utf8')); } catch { return { verdict: 'USAGE_ERROR', exitCode: VERIFY_EXIT_CODES.USAGE, key: 'publicKey' }; }
  let keyId;
  try { keyId = publicKeyId(key); } catch { return { verdict: 'USAGE_ERROR', exitCode: VERIFY_EXIT_CODES.USAGE, key: 'publicKey' }; }
  let anchor;
  try { anchor = await inspectAnchorRepo(anchorRepo, gitTimeoutMs); }
  catch (error) { return { verdict: 'ANCHOR_UNAVAILABLE', exitCode: VERIFY_EXIT_CODES.ANCHOR, detail: error instanceof SealerStop ? error.detail : undefined }; }
  const anchorPath = anchorRelativePath(keyId);
  const history = await readAnchorHistory(anchor.root, ref, anchorPath, gitTimeoutMs);
  const base = { keyId, anchorPath, anchorCommits: history.commits.length };
  if (!history.appendOnly) return { ...base, verdict: 'ANCHOR_INVALID', exitCode: VERIFY_EXIT_CODES.FAILED, problem: history.problem, commit: history.commit,
    summary: '錨點檔不是只追加：有提交刪改了先前的檢查點。' };
  let checkpoints;
  try { checkpoints = parseLines(history.text); } catch { return { ...base, verdict: 'ANCHOR_INVALID', exitCode: VERIFY_EXIT_CODES.FAILED, problem: 'ANCHOR_ENTRY_UNPARSEABLE' }; }
  const log = verifyCheckpointLog(checkpoints, key);
  if (log.status !== 'VALID') return { ...base, verdict: 'ANCHOR_INVALID', exitCode: VERIFY_EXIT_CODES.FAILED, problem: log.firstProblem,
    summary: '錨點中的檢查點簽章或鏈結不成立。' };
  if (!checkpoints.length) return { ...base, verdict: 'NO_CHECKPOINTS', exitCode: VERIFY_EXIT_CODES.FAILED, summary: '錨點倉庫沒有這把公鑰的檢查點，無法驗證。' };

  let snapshot;
  try { snapshot = readJournalReadOnly(db, { timeoutMs: dbTimeoutMs }); }
  catch (error) {
    if (error instanceof EvidenceSealError) return { ...base, verdict: error.code, exitCode: VERIFY_EXIT_CODES.DATABASE, summary: '資料庫不可用或被鎖住，未驗證。' };
    throw error;
  }
  const comparison = compareJournalToCheckpoints({ genesis: snapshot.genesis, rows: snapshot.rows, checkpoints });
  if (comparison.status === 'MATCH' && comparison.tail.status === 'LINKED' && comparison.journalSequence > 0
    && snapshot.metaStateDigest !== comparison.chain.stateDigest) findings.push({ kind: 'STATE_DIGEST_MISMATCH' });
  if (comparison.status === 'MATCH' && comparison.tail.status !== 'LINKED') findings.push({ kind: 'UNSEALED_TAIL_BROKEN', firstBreak: comparison.tail.firstBreak });

  let sealLogStatus = null;
  if (sealLog !== undefined) {
    try {
      const local = parseLines(readFileSync(sealLog, 'utf8'));
      const conflict = checkpoints.findIndex((entry, index) => local[index]?.digest !== entry.digest);
      sealLogStatus = conflict >= 0 ? { status: 'CONFLICT', index: conflict } : { status: 'CONSISTENT', unanchored: Math.max(0, local.length - checkpoints.length) };
      if (conflict >= 0) findings.push({ kind: 'SEAL_LOG_CONFLICT', index: conflict });
    } catch { sealLogStatus = { status: 'UNREADABLE' }; findings.push({ kind: 'SEAL_LOG_UNREADABLE' }); }
  }
  const external = await remoteStatus(anchor.root, history.commits.at(-1), gitTimeoutMs);
  const evidenceIntegrity = external.status === 'RECORDED_PUSHED' ? 'EXTERNALLY_ANCHORED' : 'SAME_HOST_SELF_ATTESTED';
  const last = checkpoints.at(-1);
  const report = { ...base, journalKeyMode: snapshot.journalKeyMode, checkpoints: checkpoints.length,
    lastCheckpoint: { index: last.index, sequence: last.sequence, head: last.head, sealedAt: last.sealedAt, reason: last.reason, digest: last.digest },
    journalSequence: comparison.journalSequence, externalAnchor: external, evidenceIntegrity, sealLog: sealLogStatus, findings };
  if (comparison.status !== 'MATCH') {
    return { ...report, verdict: 'TAMPERED', exitCode: VERIFY_EXIT_CODES.FAILED, firstMismatch: comparison.firstMismatch,
      summary: `資料庫 journal 與已簽檢查點不一致：第一個不一致處在序號 ${comparison.firstMismatch.sequence}（${comparison.firstMismatch.kind}）。` };
  }
  const integrityText = evidenceIntegrity === 'EXTERNALLY_ANCHORED' ? '錨點已記錄推送到外部 remote（依本機 remote-tracking ref，未即時連線讀回）'
    : '錨點只在同一台機器，證據完整性標為「同機自證」';
  if (findings.length) return { ...report, verdict: 'INCONSISTENT', exitCode: VERIFY_EXIT_CODES.FAILED, sealedThroughSequence: comparison.sealedThroughSequence,
    unsealedEvents: comparison.unsealedEvents, summary: `已簽範圍吻合，但有其他不一致：${findings.map(item => item.kind).join('、')}。` };
  return { ...report, verdict: 'VERIFIED', exitCode: VERIFY_EXIT_CODES.VERIFIED, sealedThroughSequence: comparison.sealedThroughSequence,
    unsealedEvents: comparison.unsealedEvents,
    summary: `序號 1–${comparison.sealedThroughSequence} 與已簽檢查點一致；之後 ${comparison.unsealedEvents} 個事件尚未封存、不在保證範圍內。${integrityText}。` };
}

/**
 * M7：驗證事件 manifest 的簽章聲明。只用公鑰與錨點倉庫：聲明檔與檢查點檔都必須只追加、簽章與鏈結成立；
 * 同一事件同一種類以最新一筆為準，其 manifest 摘要必須等於呼叫端重算的值，且其 journal 位置必須落在
 * 它所指的已簽檢查點內。永不寫入。
 */
export async function verifyManifestAttestations({ publicKey, anchorRepo, ref = 'HEAD', incidentId, kind, manifestDigest,
  journalSequence, journalHead, gitTimeoutMs = 30_000 }) {
  if (typeof publicKey !== 'string' || !isAbsolute(publicKey) || typeof anchorRepo !== 'string' || !isAbsolute(anchorRepo)
    || typeof incidentId !== 'string' || typeof kind !== 'string' || typeof manifestDigest !== 'string') {
    return { verdict: 'USAGE_ERROR', exitCode: VERIFY_EXIT_CODES.USAGE };
  }
  let key; let keyId;
  try { key = createPublicKey(readFileSync(publicKey, 'utf8')); keyId = publicKeyId(key); }
  catch { return { verdict: 'USAGE_ERROR', exitCode: VERIFY_EXIT_CODES.USAGE, key: 'publicKey' }; }
  let anchor;
  try { anchor = await inspectAnchorRepo(anchorRepo, gitTimeoutMs); }
  catch (error) { return { verdict: 'ANCHOR_UNAVAILABLE', exitCode: VERIFY_EXIT_CODES.ANCHOR, detail: error instanceof SealerStop ? error.detail : undefined }; }
  const invalid = (problem, extra = {}) => ({ verdict: 'ANCHOR_INVALID', exitCode: VERIFY_EXIT_CODES.FAILED, problem, ...extra });
  const manifests = await readAnchorHistory(anchor.root, ref, manifestAnchorRelativePath(keyId), gitTimeoutMs);
  if (!manifests.appendOnly) return invalid(manifests.problem, { file: 'MANIFEST_ATTESTATIONS', commit: manifests.commit });
  const checkpointHistory = await readAnchorHistory(anchor.root, ref, anchorRelativePath(keyId), gitTimeoutMs);
  if (!checkpointHistory.appendOnly) return invalid(checkpointHistory.problem, { file: 'CHECKPOINTS', commit: checkpointHistory.commit });
  let entries; let checkpoints;
  try { entries = parseLines(manifests.text); checkpoints = parseLines(checkpointHistory.text); } catch { return invalid('ANCHOR_ENTRY_UNPARSEABLE'); }
  const attestationLog = verifyManifestAttestationLog(entries, key);
  if (attestationLog.status !== 'VALID') return invalid(attestationLog.firstProblem, { file: 'MANIFEST_ATTESTATIONS' });
  const checkpointLog = verifyCheckpointLog(checkpoints, key);
  if (checkpointLog.status !== 'VALID') return invalid(checkpointLog.firstProblem, { file: 'CHECKPOINTS' });
  const matching = entries.filter(entry => entry.incidentId === incidentId && entry.kind === kind);
  const latest = matching.at(-1);
  if (!latest) return { verdict: 'NOT_FOUND', exitCode: VERIFY_EXIT_CODES.FAILED, keyId, summary: '錨點倉庫沒有這個事件與種類的 manifest 聲明。' };
  const attestation = { index: latest.index, digest: latest.digest, kind: latest.kind, manifestDigest: latest.manifestDigest,
    journalSequence: latest.journalSequence, journalHead: latest.journalHead, checkpointIndex: latest.checkpointIndex,
    checkpointDigest: latest.checkpointDigest, attestedAt: latest.attestedAt, superseded: matching.length - 1 };
  if (latest.manifestDigest !== manifestDigest) {
    return { verdict: 'MISMATCH', exitCode: VERIFY_EXIT_CODES.FAILED, keyId, attestation, problem: 'MANIFEST_DIGEST_MISMATCH',
      summary: '目前的 manifest 與最新的已簽聲明不一致：manifest 或其列出的證據檔被改過。' };
  }
  if ((journalSequence !== undefined && journalSequence !== latest.journalSequence) || (journalHead !== undefined && journalHead !== latest.journalHead)) {
    return { verdict: 'MISMATCH', exitCode: VERIFY_EXIT_CODES.FAILED, keyId, attestation, problem: 'MANIFEST_JOURNAL_MISMATCH',
      summary: 'manifest 記錄的 journal 位置與已簽聲明不一致。' };
  }
  const covering = findCoveringCheckpoint(checkpoints, latest.journalSequence, latest.journalHead);
  if (!covering || covering.index !== latest.checkpointIndex || covering.digest !== latest.checkpointDigest) {
    return { verdict: 'MISMATCH', exitCode: VERIFY_EXIT_CODES.FAILED, keyId, attestation, problem: 'CHECKPOINT_LINK_INVALID',
      summary: '聲明所指的 journal 位置不在它引用的已簽檢查點內。' };
  }
  const external = await remoteStatus(anchor.root, manifests.commits.at(-1), gitTimeoutMs);
  const evidenceIntegrity = external.status === 'RECORDED_PUSHED' ? 'EXTERNALLY_ANCHORED' : 'SAME_HOST_SELF_ATTESTED';
  return { verdict: 'VERIFIED', exitCode: VERIFY_EXIT_CODES.VERIFIED, keyId, attestation, externalAnchor: external, evidenceIntegrity,
    summary: `manifest 與第 ${latest.index} 筆已簽聲明一致，涵蓋 journal 序號 1–${latest.journalSequence}。` };
}

const USAGE = `用法：
  node scripts/dungeonq-host/evidence-verify.mjs --db <絕對路徑> --public-key <公鑰 PEM 絕對路徑> --anchor-repo <絕對路徑>
    [--ref <Git ref，預設 HEAD>] [--seal-log <封存目錄的 checkpoints.jsonl>] [--db-timeout-ms 2000] [--git-timeout-ms 30000]
結束碼：0 驗證通過；1 竄改、不一致或沒有檢查點；2 參數錯誤；3 資料庫不可用；4 錨點倉庫不可用。`;

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { db: { type: 'string' }, 'public-key': { type: 'string' },
      'anchor-repo': { type: 'string' }, ref: { type: 'string' }, 'seal-log': { type: 'string' }, 'db-timeout-ms': { type: 'string' },
      'git-timeout-ms': { type: 'string' } } }));
  } catch { process.stderr.write(`${USAGE}\n`); return VERIFY_EXIT_CODES.USAGE; }
  const number = (name, fallback) => values[name] === undefined ? fallback : /^\d+$/u.test(values[name]) ? Number(values[name]) : Number.NaN;
  const dbTimeoutMs = number('db-timeout-ms', 2000); const gitTimeoutMs = number('git-timeout-ms', 30_000);
  if (!(dbTimeoutMs >= 0 && dbTimeoutMs <= 60_000) || !(gitTimeoutMs >= 100 && gitTimeoutMs <= 120_000)
    || (values.ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/u.test(values.ref))) {
    process.stderr.write(`${USAGE}\n`); return VERIFY_EXIT_CODES.USAGE;
  }
  const report = await verifyEvidence({ db: values.db, publicKey: values['public-key'], anchorRepo: values['anchor-repo'], ref: values.ref,
    sealLog: values['seal-log'], dbTimeoutMs, gitTimeoutMs });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary) process.stderr.write(`${report.summary}\n`);
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main();
