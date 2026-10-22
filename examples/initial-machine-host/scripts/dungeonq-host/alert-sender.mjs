import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  createImapInboxProbe,
  createLinePushChannel,
  createSmtpAlertChannel,
  privateConfigPresent
} from '../../vendor/dungeonq-runtime/server/alert-channels.mjs';

/*
 * DungeonQ 執行環境自己的寄送器（DQ-HANDOFF-015 M3，計畫第二部分 2.1–2.2）。
 *
 * - 主管道：Gmail SMTP（TLS、憑證驗證），收件人固定為 smtp.json 的 user。
 * - 備援：LINE 官方帳號推播；每次需要時以 Channel ID＋secret 換 900 秒無狀態權杖，不重新發行長期權杖。
 * - 切換規則、升級計時器、ACK 與事件紀錄都在執行環境（vendor/dungeonq-runtime/runtime/pitch-handoff.mjs）；
 *   本檔只組裝管道、檢查設定是否存在（只看檔案屬性、不讀內容），並提供 D16 實寄驗收的持久預算。
 * - 祕密檔只在寄送、登入檢查或收件匣量測的當下由執行環境轉接器讀取；本檔與日誌從不讀出、印出或寫入祕密。
 * - Codex Gmail 轉送（vendor/dungeonq-runtime/scripts/pitching-auto-relay.mjs）保留為選配：
 *   停用開關打開時入場 outbox 維持 PENDING，可由該轉送領取。
 */

export const DUNGEONQ_PRIVATE_ROOT = join(homedir(), 'Library', 'Application Support', 'DungeonQ');
export const DUNGEONQ_SMTP_CONFIG = join(DUNGEONQ_PRIVATE_ROOT, 'secrets', 'smtp.json');
export const DUNGEONQ_LINE_CONFIG = join(DUNGEONQ_PRIVATE_ROOT, 'secrets', 'line.json');
export const DUNGEONQ_ACK_ACCOUNT = join(DUNGEONQ_PRIVATE_ROOT, 'ack-operator.json');
export const DUNGEONQ_LIVE_BUDGET = join(DUNGEONQ_PRIVATE_ROOT, 'm3-acceptance', 'live-send-budget.json');

/** 入場 outbox 必須容得下兩個管道依序嘗試（執行環境以 2 × channelTimeoutMs + 1 秒檢查）。 */
export const DUNGEONQ_ALERT_PITCHING_LIMITS = Object.freeze({
  deliveryTimeoutMs: 25_000,
  deliveryLeaseMs: 30_000,
  deliveryAttempts: 3,
  retryBaseMs: 15_000
});

const STATE_TEXT = Object.freeze({
  PRESENT: '已設定',
  MISSING: '找不到設定檔',
  NOT_PRIVATE: '設定檔權限不是 0600 或不是一般檔案',
  INVALID_PATH: '設定路徑不是絕對路徑',
  UNREADABLE: '無法檢查設定檔'
});

/**
 * 組裝通知管道。設定缺漏時不默默降級：回傳的 notice 會說明「告警只存本機」或「只有單一管道」。
 *
 * @param {object} [options]
 * @param {string} [options.smtpConfigPath] Gmail SMTP 設定（0600）。
 * @param {string} [options.lineConfigPath] LINE 設定（0600）。
 * @param {boolean} [options.measureInbox] 是否以 IMAP 唯讀量測收件匣到達時間（D13）。
 * @param {{ reserve(channel: string): boolean }} [options.budget] 每次實際寄送前保留的預算（D16 驗收用）。
 * @param {{ host?: string, port?: number, secure?: boolean }} [options.smtpOverrides] 只供驗收以無效主機模擬主管道失敗。
 * @param {object[]} [options.channels] 測試用假管道；提供時不檢查設定檔。
 * @param {{ find: Function }} [options.inboxProbe] 測試用假收件匣量測。
 */
export function createDungeonqAlertSender({
  smtpConfigPath = DUNGEONQ_SMTP_CONFIG,
  lineConfigPath = DUNGEONQ_LINE_CONFIG,
  measureInbox = false,
  budget,
  smtpOverrides,
  channels: injected,
  inboxProbe: injectedProbe
} = {}) {
  if (budget !== undefined && typeof budget?.reserve !== 'function') throw new Error('ALERT_BUDGET_INVALID');
  const primary = injected ? (injected.some((channel) => channel.role === 'PRIMARY') ? 'PRESENT' : 'MISSING') : privateConfigPresent(smtpConfigPath);
  const fallback = injected ? (injected.some((channel) => channel.role === 'FALLBACK') ? 'PRESENT' : 'MISSING') : privateConfigPresent(lineConfigPath);
  const channels = injected ?? [
    ...(primary === 'PRESENT' ? [createSmtpAlertChannel({ configPath: smtpConfigPath, budget, overrides: smtpOverrides })] : []),
    ...(fallback === 'PRESENT' ? [createLinePushChannel({ configPath: lineConfigPath, budget })] : [])
  ];
  const inboxProbe = !measureInbox ? undefined
    : injectedProbe ?? (primary === 'PRESENT' ? createImapInboxProbe({ configPath: smtpConfigPath }) : undefined);
  const notice = [];
  if (channels.length === 0) {
    notice.push(`告警只存本機：主管道 Gmail ${STATE_TEXT[primary]}、備援 LINE ${STATE_TEXT[fallback]}；不會對外寄送，升級時間表與本機最高優先告警照常運作。`);
  } else {
    if (primary !== 'PRESENT') notice.push(`只有備援管道：主管道 Gmail ${STATE_TEXT[primary]}。`);
    if (fallback !== 'PRESENT') notice.push(`只有主管道：備援 LINE ${STATE_TEXT[fallback]}。`);
  }
  if (measureInbox && !inboxProbe) notice.push('收件匣到達時間無法量測：沒有 Gmail 設定，將記為 UNKNOWN。');
  return Object.freeze({
    notifier: Object.freeze({ channels }),
    inboxProbe,
    delivery: Object.freeze({
      configured: channels.length > 0,
      primary,
      fallback,
      inboxMeasurement: Boolean(inboxProbe),
      channels: channels.map((channel) => ({ name: channel.name, role: channel.role })),
      notice: Object.freeze(notice)
    })
  });
}

/** 本機控制台告警：印在執行 DungeonQ 的終端機（stderr），最高優先時加醒目框線。 */
export function createLocalConsole({ write = (text) => process.stderr.write(text) } = {}) {
  return (alert) => {
    const critical = alert.level === 'CRITICAL';
    const bar = critical ? '!'.repeat(72) : '-'.repeat(72);
    const lines = [
      '',
      bar,
      `${critical ? '【DungeonQ 最高優先告警】' : '【DungeonQ 告警】'}${alert.message}`,
      ...(alert.ackLink ? [`ACK 連結（只限這台 Mac 開啟）：${alert.ackLink}`] : []),
      bar,
      ''
    ];
    write(lines.join('\n'));
  };
}

function durableWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/**
 * D16 實寄驗收預算：持久計數器，整個 M3 期間合計最多 5 封 Gmail、5 則 LINE。
 * 每次實際寄送前先保留並寫入磁碟；保留後寄送失敗也不退還，所以當機或重跑都不會超量。
 */
export function openLiveSendBudget({ path = DUNGEONQ_LIVE_BUDGET, limits = { GMAIL_SMTP: 5, LINE_PUSH: 5 }, clock = () => new Date().toISOString() } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('ALERT_BUDGET_PATH_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error('ALERT_BUDGET_DIRECTORY_NOT_PRIVATE');
  const read = () => {
    let info;
    try { info = lstatSync(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { schemaVersion: 'dungeonq.m3-live-send-budget/v1', limits, used: Object.fromEntries(Object.keys(limits).map((key) => [key, 0])), history: [] };
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('ALERT_BUDGET_FILE_NOT_PRIVATE');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.schemaVersion !== 'dungeonq.m3-live-send-budget/v1' || JSON.stringify(value.limits) !== JSON.stringify(limits)) throw new Error('ALERT_BUDGET_CHANGED');
    return value;
  };
  return Object.freeze({
    path,
    reserve(channel) {
      const state = read();
      if (!Object.hasOwn(state.limits, channel) || state.used[channel] >= state.limits[channel]) return false;
      state.used[channel] += 1;
      state.history.push({ channel, at: clock() });
      durableWrite(path, state);
      return true;
    },
    remaining(channel) {
      const state = read();
      return Object.hasOwn(state.limits, channel) ? state.limits[channel] - state.used[channel] : 0;
    },
    snapshot: () => structuredClone(read())
  });
}
