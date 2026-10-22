// M9：可信主機上的真人控制面；不掛入 participant 容器、不提供通用執行端點。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPitchHandoff } from '../../vendor/dungeonq-runtime/runtime/pitch-handoff.mjs';
import { body, headers, insist, send, serve } from '../../vendor/dungeonq-runtime/runtime/transport.mjs';
import { DUNGEONQ_RESPONSE_ACTION_CATALOG, authorizeDungeonqResponseAction } from '../../packages/policy/src/dungeonq-response-action.ts';

export async function openHumanSourceHandoff({ directory, alert, accountPath, sender, execute, emit, ticketSummary,
  enteredAt = alert.receivedAt, observationMode = 'HUMAN', schedule = true, executeClose }) {
  let attempt = null, execution = null, closed = false, verifiedAck = null;
  let closeAttempt = null, closeResult = null;
  let primaryAttempts = 0;
  const action = DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.find(row => row.name === 'ROTATE_CREDENTIAL_WITH_OVERLAP');
  insist(action, 'SOURCE_POLICY_VERSION_UNSUPPORTED');
  const incident = { incidentId: alert.incidentId, contextId: 'diverted', worldId: 'dungeon', epoch: 1, enteredAt };
  // 本場不接 T+10 自動處置，告警文字必須符合這個有界真人試驗的行為。
  const notifier = { channels: sender.notifier.channels.map(channel => ({ ...channel,
    send: (message, options) => {
      // 本場另一封 Gmail 保留給結案通知；升級不可先用掉它。
      if (channel.role === 'PRIMARY' && primaryAttempts++ >= 1) return { state: 'QUOTA', code: 'M9_ENTRY_PRIMARY_LIMIT' };
      return channel.send({ ...message, text: message.text.replace(/^若在約[^\n]+$/mu,
        '本場是隔離環境的真人驗收：登入確認後，請送出 A-2「輪替隔離測試憑證」。未確認或未決策不會輪替，最長等待 9 分鐘後保留 UNKNOWN 並停止。') }, options);
    }
  })) };
  const handoff = openPitchHandoff({ path: join(directory, 'human-handoff.sqlite'), notifier,
    inboxProbe: sender.inboxProbe, ackAccount: { path: accountPath }, prefix: 'TEST', selfCheck: 'LOGIN', schedule,
    limits: { channelTimeoutMs: 25000, stageRetryMax: 0 },
    isClosed: () => closed,
    localConsole: value => emit('LOCAL_NOTICE', { reason: value.reason, stage: value.stage ?? null }),
    ticketSummary,
    onAcknowledged: value => { verifiedAck = value; emit('VERIFIED_ACK', { ...value, observationMode }); },
    summary: async () => ({
      realAssetReads: { status: 'NOT_MEASURED', count: null },
      automaticActions: { source: 'LEDGER', items: execution?.result ? [execution.result] : [] },
      legitimateHealth: { status: 'CHECKED_AT_DECISION', reason: '執行前及觀察窗結束以四條來源路徑重新量測。' },
      recommendations: [{ actionCode: action.code, actionName: '輪替隔離測試憑證', impact: '新能力在四條路徑就緒後，撤銷舊能力；只影響本場合成實驗室。' }],
      decisionOptions: { aClass: [{ actionCode: action.code, actionName: '輪替隔離測試憑證',
        impact: '只執行一次；結果不明不重送。停止演練可回終端機按 Ctrl+C。',
        targets: [{ targetId: 'source-credential', kind: 'CREDENTIAL' }] }], bClass: [], close: {
        available: typeof executeClose === 'function' && execution?.result?.status === 'EXECUTED' && execution?.result?.readback === 'CONFIRMED' && !closeAttempt,
        reason: closeAttempt ? '本場結案已送出；請查看結果，不會自動重送。' : 'A-2 讀回生效後，重新整理摘要即可開始結束流程。' } }
    }),
    decision: async value => {
      const { request, actor, acknowledgement } = value;
      if (closed || value.incidentId !== alert.incidentId || !verifiedAck
        || acknowledgement?.at !== verifiedAck.at || actor?.account !== verifiedAck.account) {
        return { outcome: 'REJECTED', reason: 'HUMAN_SOURCE_SCOPE_DENIED' };
      }
      if (request.kind === 'START_CLOSE') {
        if (typeof executeClose !== 'function' || closeAttempt || execution?.result?.status !== 'EXECUTED' || execution?.result?.readback !== 'CONFIRMED')
          return { outcome: 'REJECTED', reason: 'HUMAN_CLOSE_NOT_READY' };
        try { executeClose.validate?.(value); }
        catch (error) {
          emit('HUMAN_CLOSE_REJECTED', { reason: error.code ?? 'CLOSE_INPUT_INVALID', effectsStarted: false });
          return { outcome: 'REJECTED', reason: error.code ?? 'CLOSE_INPUT_INVALID' };
        }
        emit('HUMAN_CLOSE_DECISION', { incidentId: value.incidentId, decisionId: value.decisionId, submittedAt: value.submittedAt,
          acknowledgement, actor, observationMode });
        closeAttempt = Promise.resolve().then(() => executeClose(value));
        try {
          closeResult = await closeAttempt;
          return { outcome: closeResult.status === 'CLOSED' ? 'CLOSED' : 'CLOSE_HALTED', reason: closeResult.code ?? 'M7_CLOSE_READBACK', close: closeResult };
        } catch (error) {
          closeResult = { status: 'UNKNOWN', code: error.code ?? error.message ?? 'CLOSE_UNKNOWN' };
          emit('CLOSE_UNKNOWN', { reason: closeResult.code, resend: false });
          return { outcome: 'UNKNOWN', reason: closeResult.code };
        }
      }
      if (attempt || request.kind !== 'EXECUTE_A_CLASS' || request.actionCode !== action.code || request.targetId !== 'source-credential')
        return { outcome: 'REJECTED', reason: 'HUMAN_SOURCE_SCOPE_DENIED' };
      // 權限由 M3 的已驗證會話與單次決策權杖取得；execute 仍走既有 @eva/policy / M5。
      emit('HUMAN_ROTATE_DECISION', { incidentId: value.incidentId, decisionId: value.decisionId,
        submittedAt: value.submittedAt, acknowledgement, actor, observationMode });
      const beforeExecute = ({ decision, input, request: selected }) => {
        insist(selected.incidentId === alert.incidentId && selected.actionCode === request.actionCode
          && selected.targetId === request.targetId, 'HUMAN_SOURCE_POLICY_SCOPE_DENIED');
        const authorization = authorizeDungeonqResponseAction({ decision, input, request: selected, purpose: 'EXECUTE_A_CLASS' });
        emit('HUMAN_POLICY_AUTHORIZATION', { authorized: authorization.authorized, incidentId: alert.incidentId });
        insist(authorization.authorized, 'HUMAN_SOURCE_POLICY_DENIED');
      };
      attempt = Promise.resolve().then(() => execute(value, beforeExecute));
      try {
        execution = await attempt;
        return { outcome: execution.result?.status === 'EXECUTED' && execution.result?.readback === 'CONFIRMED' ? 'EXECUTED' : 'UNKNOWN',
          reason: 'SCOPED_SOURCE_READBACK', readback: execution.result?.readback ?? 'UNKNOWN', action: execution.result };
      } catch (error) {
        execution = { result: { status: 'UNKNOWN', readback: 'UNKNOWN' }, error: error.code ?? 'SOURCE_EXECUTION_UNKNOWN' };
        emit('ROTATION_UNKNOWN', { reason: execution.error, resend: false });
        return { outcome: 'UNKNOWN', reason: execution.error };
      }
    }
  });
  const staticFiles = new Map([
    ['/ack/app.mjs', ['ack.mjs', 'text/javascript']], ['/ack/ack.css', ['ack.css', 'text/css']]
  ]);
  let http;
  try {
    http = await serve(async (req, res) => {
      if (req.method === 'GET') {
        const file = staticFiles.get(req.url)
          ?? (/^\/ack\/incident-[a-f0-9]{64}\/[A-Za-z0-9_-]{43}$/.test(req.url) ? ['ack.html', 'text/html'] : null);
        insist(file, 'NOT_FOUND'); headers(res); res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
        return res.end(readFileSync(new URL('../../vendor/dungeonq-runtime/public/runtime/' + file[0], import.meta.url)));
      }
      insist(req.method === 'POST', 'NOT_FOUND');
      // 所有管理員 POST 都要求同來源，包括登入，避免 cross-site 登入與決策。
      insist(req.headers.origin === http.origin, 'ORIGIN_DENIED');
      const from = { origin: req.headers.origin };
      if (req.url === '/ack/verify') return send(res, 200, await handoff.verifyAck(await body(req, 4096)));
      if (req.url === '/ack/summary') return send(res, 200, await handoff.summary(await body(req, 1024)));
      if (req.url === '/ack/decision/token') return send(res, 200, await handoff.issueDecisionToken(await body(req, 1024), from));
      if (req.url === '/ack/decision') return send(res, 200, await handoff.submitDecision(await body(req, 16384), from));
      if (req.url === '/ack/decision/status') return send(res, 200, await handoff.decisionStatus(await body(req, 1024), from));
      insist(false, 'NOT_FOUND');
    }, { browser: true, ackNavigation: true });
    handoff.bindOrigin(http.origin);
    handoff.arm(incident);
    await handoff.start();
    return {
      origin: http.origin,
      status: () => handoff.publicStatus(),
      execution: () => execution,
      closeResult: () => closeResult,
      closing: () => closeAttempt !== null && closeResult === null,
      running: () => attempt !== null && execution === null,
      async sendEntry() {
        // 不另外產生聊天 ACK 連結，避免人先從聊天進入而誤認郵件送達。
        emit('EXTERNAL_ALERT_QUEUED', { incidentId: incident.incidentId });
        try {
          const result = await handoff.entrySend({ incident, idempotencyKey: `m9:${incident.incidentId}`, attempt: 1 });
          emit('EXTERNAL_ALERT_RESULT', result); return result;
        } catch (error) { emit('EXTERNAL_ALERT_UNKNOWN', { code: error.code ?? 'DELIVERY_UNKNOWN', resend: false }); return { accepted: false, unknown: true }; }
      },
      async close() {
        closed = true;
        handoff.disable({ reason: 'M9_SINGLE_TRIAL_ENDED' });
        await http.close();
        // 等待已送出的單次處置有界完成；不得以中斷後重送修補不明結果。
        await attempt?.catch(() => {});
        await closeAttempt?.catch(() => {});
        writeFileSync(join(directory, 'handoff-final.json'), JSON.stringify(handoff.publicStatus(), null, 2), { mode: 0o600 });
        await handoff.close();
      }
    };
  } catch (error) { await http?.close(); await handoff.close(); throw error; }
}
