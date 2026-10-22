// 私人、離線的驗收讀本；不載入第三方服務，不顯示密碼、OTP 或能力原值。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const esc = value => String(value ?? 'UNKNOWN').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : 'UNKNOWN';
const duration = value => Number.isFinite(value) ? `${(value / 1000).toFixed(3)} 秒` : 'UNKNOWN';
export function renderHumanSourceReplay(directory) {
  const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  const processRows = readFileSync(join(directory, 'process.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const metrics = result.metrics, human = result.observationMode === 'HUMAN';
  const stages = [['告警供應商接受', metrics.providerAcceptedAt], ['收件匣到達（信箱時鐘）', metrics.inboxArrival?.at],
    [human ? '本人 ACK' : '測試帳號 ACK', metrics.verifiedHumanAckAt], ['送出 A-2', metrics.decisionAt],
    ['rotate 完整讀回', metrics.rotationVerifiedAt], ['送出結案', metrics.closeDecisionAt], ['結案完成', metrics.closedAt]];
  const rows = stages.map(([name, at]) => `<tr><td>${esc(name)}</td><td>${esc(time(at))}</td></tr>`).join('');
  const steps = Object.entries(result.close?.steps ?? {}).map(([name, step]) => `<tr><td>${esc(name)}</td><td>${esc(step.state)}</td><td>${esc(step.failure?.code ?? '—')}</td></tr>`).join('');
  const details = processRows.map(row => `<tr><td>${row.seq}</td><td>${esc(time(row.at))}</td><td>${esc(row.kind)}</td><td>${esc(row.detail?.reason ?? row.detail?.action ?? row.detail?.name ?? '—')}</td></tr>`).join('');
  const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DungeonQ · ${human ? '真人' : '腳本'}結案驗收</title><style>
body{background:#101713;color:#e9eee7;font:17px/1.7 system-ui;margin:0}main{max-width:1000px;margin:auto;padding:52px 28px}h1{font-size:40px;line-height:1.2;margin:12px 0 24px}h2{margin-top:42px;font-size:25px}small,.muted{color:#b4c1b1}strong,a{color:#c9ec9c}a{margin-right:20px}table{border-collapse:collapse;width:100%;font-size:15px}td,th{text-align:left;padding:10px;border-bottom:1px solid #344233}th{color:#c9ec9c}p{max-width:850px}.status{border-left:4px solid #b2d882;padding:12px 20px;background:#1b271d}details{margin-top:32px}summary{cursor:pointer;color:#c9ec9c}code{overflow-wrap:anywhere;font-size:13px} @media(max-width:650px){main{padding:24px 16px}h1{font-size:30px}td{padding:7px;font-size:12px}}
</style><main><small>DUNGEONQ · M9 / 私人驗收紀錄</small><h1>從告警到處置，再到結案</h1>
<p class="status"><strong>${esc(result.outcome)}</strong><br>${human ? '本人 ACK 與決策；參與者為腳本。' : '測試帳號、腳本決策、假通知；不列入真人場數。'} 付費 AI 呼叫：${esc(result.paidCalls)}。</p>
<p>告警供應商接受 → rotate 完整讀回：<strong>${esc(duration(metrics.humanResponseMs))}</strong><br>rotate 完整讀回 → 結案：<strong>${esc(duration(metrics.rotationToClosedMs))}</strong><br>告警供應商接受 → 結案：<strong>${esc(duration(metrics.providerToClosedMs))}</strong></p>
<p class="muted">這是流程耗時。DungeonQ 額外爭取的時間仍為 NOT_PROVEN；真實攻擊者是否持續探索仍為 UNKNOWN。腳本自行停止會保留，不恢復探索來湊時間。簽章信任範圍為同機自證。</p>
<h2>時間線（台灣時間）</h2><table><thead><tr><th>節點</th><th>觀察時間</th></tr></thead><tbody>${rows}</tbody></table>
<h2>結案步驟</h2><table><thead><tr><th>步驟</th><th>結果</th><th>失敗代碼</th></tr></thead><tbody>${steps || '<tr><td colspan="3">UNKNOWN：尚無結案結果</td></tr>'}</tbody></table>
<p>失敗：${esc(result.failure ?? '無已記錄失敗')}。未知項：${esc(metrics.unknown?.join('、'))}。合法消費者成功 ${esc(result.legitimateHealth.successful)}／${esc(result.legitimateHealth.total)}。</p>
<h2>原始證據</h2><p><a href="timeline.json">時間線</a><a href="result.json">完整結果</a><a href="process.jsonl">完整過程</a><a href="code-manifest.json">程式摘要</a>${result.close ? '<a href="incident-close/post-incident-report.md">事後報告</a>' : ''}</p>
<p class="muted">過程 SHA-256：<code>${esc(readFileSync(join(directory, 'process.sha256'), 'utf8').trim())}</code></p>
<details><summary>展開完整事件索引（${processRows.length} 筆；不顯示能力原值）</summary><table><thead><tr><th>#</th><th>時間</th><th>事件</th><th>原因／動作</th></tr></thead><tbody>${details}</tbody></table></details></main></html>`;
  writeFileSync(join(directory, 'replay.html'), html, { mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) renderHumanSourceReplay(resolve(process.argv[2]));
