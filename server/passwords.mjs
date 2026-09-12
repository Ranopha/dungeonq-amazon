import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { requireThat } from './contracts.mjs';

const derive = promisify(argon2);
const PARAMETERS = Object.freeze({ memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 });
// 初始 Lab 字典不是完整洩漏密碼資料庫；網路開放前需加入版本化離線字典。
const BLOCKED = new Set(['passwordpassword', 'password123456789', '123456789012345',
  '1234567890123456', 'qwertyuiopasdfgh', 'letmeinletmeinletmein']);
let activeHashes = 0;

export function passwordText(value, enrolling = false) {
  requireThat(typeof value === 'string' && Buffer.byteLength(value) <= 1024, 'PASSWORD_INVALID');
  const text = value.normalize('NFC');
  const length = [...text].length;
  requireThat(length >= 1 && length <= 128, 'PASSWORD_INVALID');
  if (enrolling) requireThat(length >= 15 && !BLOCKED.has(text.toLowerCase())
    && new Set([...text]).size > 1, 'PASSWORD_POLICY');
  return text;
}
async function calculate(text, salt) {
  requireThat(activeHashes < 2, 'AUTH_CAPACITY');
  activeHashes++;
  try { return await derive('argon2id', { ...PARAMETERS, message: text, nonce: salt }); }
  finally { activeHashes--; }
}
export async function hashPassword(password) {
  const text = passwordText(password, true);
  const salt = randomBytes(16);
  const hash = await calculate(text, salt);
  return JSON.stringify({ algorithm: 'argon2id', version: 1, ...PARAMETERS,
    salt: salt.toString('hex'), hash: hash.toString('hex') });
}
export async function verifyPassword(password, encoded) {
  const text = passwordText(password);
  const record = JSON.parse(encoded);
  requireThat(record.algorithm === 'argon2id' && record.version === 1
    && Object.entries(PARAMETERS).every(([key, value]) => record[key] === value)
    && /^[a-f0-9]{32}$/u.test(record.salt) && /^[a-f0-9]{64}$/u.test(record.hash), 'PASSWORD_RECORD_INVALID');
  return timingSafeEqual(await calculate(text, Buffer.from(record.salt, 'hex')), Buffer.from(record.hash, 'hex'));
}
