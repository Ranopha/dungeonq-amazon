// First stdin line: JSON with endpoint + actorToken. No credentials in argv or output.
import { createInterface } from 'node:readline';
import { runShippingReview, validateConfiguration, requireCondition, errorSummary } from './client.mjs';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const emit = message => {
  if (process.send) process.send(message);
  if (message.type !== 'ticket') process.stdout.write(JSON.stringify(message) + '\n');
};
try {
  const first = await iterator.next();
  requireCondition(!first.done && first.value.length <= 8192, 'CONFIGURATION_REQUIRED');
  let input;
  try { input = JSON.parse(first.value); } catch { throw Object.assign(new Error('INVALID_CONFIGURATION'), { code: 'INVALID_CONFIGURATION' }); }
  const config = validateConfiguration(input);
  const report = await runShippingReview(config, {
    onScene: scene => emit({ type: 'scene', scene }),
    beforeTicket: async review => {
      if (!config.waitForOperator) return;
      emit({ type: 'operator-boundary', revision: review.revision });
      const next = await iterator.next();
      requireCondition(!next.done && next.value.trim() === '{"continue":true}', 'OPERATOR_CONTINUATION_REQUIRED');
    },
    // Only the trusted harness receives the transient ticket over private IPC.
    onTicket: ticket => { if (process.send) emit({ type: 'ticket', ticket }); },
  });
  emit({ type: 'complete', report });
} catch (error) {
  emit({ type: 'failure', status: 'FAIL', error: errorSummary(error) });
  process.exitCode = 1;
} finally { lines.close(); process.stdin.destroy(); if (process.connected) process.disconnect(); }
