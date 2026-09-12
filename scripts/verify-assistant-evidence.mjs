import { readFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import { verifyReceipt } from '../server/governance.mjs';

// The verifier never trusts a public key embedded in the evidence being verified.
// Obtain the PEM/key ID separately from your own lab before receiving evidence.
const [evidencePath, keyPath, keyId, ...extra] = process.argv.slice(2);
try {
  if (!evidencePath || !keyPath || !keyId || extra.length) throw new Error('USAGE');
  const bytes = await readFile(evidencePath);
  if (bytes.length > 524_288) throw new Error('SIZE_LIMIT');
  const evidence = JSON.parse(bytes.toString('utf8'));
  const publicKey = createPublicKey(await readFile(keyPath));
  const valid = evidence.schemaVersion === 'dungeonq.assistant-evidence/v1'
    && verifyReceipt(evidence.response?.receipt, publicKey, keyId);
  process.stdout.write(JSON.stringify({ schemaVersion: 'dungeonq.offline-receipt-check/v1',
    profile: 'SYNTHETIC_ONLY', receiptValid: valid, checked: 'SIGNED_RECEIPT_ONLY',
    envelopeAuthenticated: false, sourceTruthProven: false }) + '\n');
  if (!valid) process.exitCode = 1;
} catch {
  process.stderr.write('Use: npm run verify:assistant-evidence -- evidence.json trusted-public-key.pem trusted-key-id\nVerification failed or input was invalid. No network request was made.\n');
  process.exitCode = 1;
}
