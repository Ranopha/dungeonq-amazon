import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEmailAcceptance } from '../server/email-acceptance.mjs';

test('Email真實本機HTTPS同事故：驗證、登入別名、收件、重啟、移除，不代表真實外寄', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-email-integration-'));
  const { report } = await runEmailAcceptance({ directory });
  assert.equal(report.passed, true); assert.equal(report.checks.length, 9);
  assert.equal(report.externalEmailSent, false); assert.equal(report.liveOAuthProviderUsed, false);
  assert.equal(report.inboxDeliveryProven, false);
});
