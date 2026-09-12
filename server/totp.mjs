import { createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { requireThat } from './contracts.mjs';

// RFC 6238；30 秒、SHA-1、六位；不宣稱抗釣魚。
export function otpAt(seed, step, digits = 6) {
  requireThat(Buffer.isBuffer(seed) && seed.length >= 20 && Number.isSafeInteger(step) && step >= 0
    && [6, 8].includes(digits), 'TOTP_INVALID');
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', seed).update(counter).digest();
  return String((mac.readUInt32BE(mac[mac.length - 1] & 15) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function matchOtp(seed, code, now, lastStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate >= 0 && candidate > lastStep && timingSafeEqual(Buffer.from(otpAt(seed, candidate)), Buffer.from(code))) return candidate;
  }
  return null;
}
export function base32(bytes) {
  let bits = 0; let value = 0; let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> bits) & 31]; }
  }
  if (bits) result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value << (5 - bits)) & 31];
  return result;
}
export function seedVault(key) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, 'TOTP_KEY_REQUIRED');
  const custodyKey = Buffer.from(key);
  return Object.freeze({
    seal(seed, binding) {
      requireThat(Buffer.isBuffer(seed) && [20, 32].includes(seed.length), 'TOTP_INVALID');
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', custodyKey, iv);
      cipher.setAAD(Buffer.from(binding));
      const bytes = Buffer.concat([cipher.update(seed), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
    },
    open(encoded, binding) {
      try {
        requireThat(typeof encoded === 'string' && /^[A-Za-z0-9_-]+$/u.test(encoded), 'TOTP_CUSTODY_FAILED');
        const bytes = Buffer.from(encoded, 'base64url');
        requireThat([48, 60].includes(bytes.length) && bytes.toString('base64url') === encoded, 'TOTP_CUSTODY_FAILED');
        const cipher = createDecipheriv('aes-256-gcm', custodyKey, bytes.subarray(0, 12));
        cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
      } catch { requireThat(false, 'TOTP_CUSTODY_FAILED'); }
    }
  });
}
