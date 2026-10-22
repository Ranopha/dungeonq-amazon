import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hashPassword, verifyPassword } from '../../vendor/dungeonq-runtime/server/passwords.mjs';
import { base32, matchOtp } from '../../vendor/dungeonq-runtime/server/totp.mjs';
import { loadAckAccountFile } from '../../vendor/dungeonq-runtime/runtime/pitch-handoff.mjs';
import { DUNGEONQ_ACK_ACCOUNT } from './alert-sender.mjs';

/*
 * DungeonQ ACK 操作員帳號（DQ-HANDOFF-015 M3，計畫 2.3）。
 *
 * ACK 連結只是單次、限時、綁定事件的指標；身分以這個本機帳號驗證：沿用執行環境既有的 Argon2id 密碼
 * （vendor/dungeonq-runtime/server/passwords.mjs，至少 15 字元）與 RFC 6238 TOTP（server/totp.mjs）。
 * 帳號啟用 TOTP 時 ACK 必填驗證碼。帳號檔只存密碼雜湊與 TOTP 種子，權限 0600，不進 Git。
 *
 * 用法（由使用者本人在終端機執行；密碼不回顯，不經指令參數）：
 *   node scripts/dungeonq-host/ack-operator.mjs enroll [--file 絕對路徑] [--operator 帳號代號] [--totp] [--replace]
 *   node scripts/dungeonq-host/ack-operator.mjs status [--file 絕對路徑]
 */

export const ACK_OPERATOR_SCHEMA = 'dungeonq.ack-operator/v1';

/** 本人終端機的設定預檢：不寄信、不建立 ACK／會話、不執行處置。 */
export async function verifyAckOperatorLocally({ path = DUNGEONQ_ACK_ACCOUNT, password, totp, now = Date.now() }) {
  const account = loadAckAccountFile(path);
  if (!account.totp || !await verifyPassword(password, account.password) || matchOtp(account.totp, totp, now) === null) {
    throw new Error('預檢未通過：請確認 ACK 密碼與驗證器目前顯示的六位數驗證碼。');
  }
  return { operatorId: account.operatorId, method: 'PASSWORD_TOTP', verifiedAt: now, incidentAcknowledged: false };
}

/** 產生帳號檔內容；只供 enroll 與測試使用。 */
export async function createAckOperatorRecord({ operatorId = 'owner', password, totp = false }) {
  if (typeof operatorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(operatorId)) throw new Error('ACK_OPERATOR_ID_INVALID');
  const seed = totp ? randomBytes(20) : null;
  return {
    record: { schemaVersion: ACK_OPERATOR_SCHEMA, operatorId, password: await hashPassword(password), totp: seed ? base32(seed) : null },
    seed
  };
}

/** 以 0600 原子寫入；預設不覆蓋既有帳號。 */
export function writeAckOperatorFile(path, record, { replace = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('ACK_ACCOUNT_PATH_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error('ACK_ACCOUNT_DIRECTORY_NOT_PRIVATE');
  if (!replace) {
    try { lstatSync(path); throw new Error('ACK_ACCOUNT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  loadAckAccountFile(path);
  return path;
}

/** 在互動終端機讀取不回顯的輸入（密碼、TOTP）；不接受管線或指令參數。也供 incident-wiring.mjs 的候選核准使用。 */
export function readHidden(prompt) {
  return new Promise((resolvePromise, reject) => {
    const input = process.stdin;
    if (!input.isTTY) { reject(new Error('需要互動終端機輸入密碼（不接受管線或指令參數）')); return; }
    process.stderr.write(prompt);
    let value = '';
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') { cleanup(); reject(new Error('已取消')); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stderr.write('\n'); resolvePromise(value); return; }
        if (char === '\u007f') value = value.slice(0, -1); else value += char;
      }
    };
    const cleanup = () => { input.removeListener('data', onData); input.setRawMode(false); input.pause(); };
    input.on('data', onData);
  });
}

async function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const path = resolve(option('--file') ?? DUNGEONQ_ACK_ACCOUNT);
  if (command === 'status') {
    try {
      const account = loadAckAccountFile(path);
      process.stdout.write(`ACK 帳號已設定：${account.operatorId}，驗證方式 ${account.totp ? '密碼＋TOTP' : '密碼'}（${path}）\n`);
    } catch { process.stdout.write(`ACK 帳號未設定或檔案不符規則（必須是 0600 一般檔）：${path}\n`); process.exitCode = 1; }
    return;
  }
  if (command === 'verify') {
    await verifyAckOperatorLocally({ path, password: await readHidden('ACK 密碼（不回顯）：'),
      totp: await readHidden('驗證器目前的六位數驗證碼（不回顯）：') });
    process.stderr.write('設定預檢通過：密碼與驗證器可用。沒有寄信、沒有確認任何事件、沒有執行 rotate。\n');
    return;
  }
  if (command !== 'enroll') throw new Error('用法：ack-operator.mjs enroll|status|verify [--file 絕對路徑] [--operator 代號] [--totp] [--replace]');
  const password = await readHidden('設定 ACK 密碼（至少 15 字元，不回顯）：');
  const confirm = await readHidden('再輸入一次：');
  if (password !== confirm) throw new Error('兩次輸入不同，未寫入');
  const { record, seed } = await createAckOperatorRecord({ operatorId: option('--operator') ?? 'owner', password, totp: rest.includes('--totp') });
  writeAckOperatorFile(path, record, { replace: rest.includes('--replace') });
  process.stderr.write(`已寫入 ACK 帳號（0600）：${path}\n`);
  if (seed) {
    // 只顯示在使用者自己的終端機一次，供驗證器 App 加入；不寫入日誌或其他檔案。
    process.stderr.write(`請把以下設定加入驗證器 App（只顯示這一次）：\notpauth://totp/DungeonQ:${record.operatorId}?secret=${base32(seed)}&issuer=DungeonQ&digits=6&period=30\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
