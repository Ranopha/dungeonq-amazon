import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  DUNGEONQ_RESPONSE_OBLIGATIONS,
  authorizeDungeonqResponseAction,
  getDungeonqResponseActionCatalogEntry
} from '../../packages/policy/src/dungeonq-response-action.ts';

/*
 * DungeonQ B 級工單（DQ-HANDOFF-015 M6，計畫第三部分 3.4，驗收 P-5）。
 *
 * B 級處置（停用帳號、更換主要密碼、重建主機、整段網路隔離、需要重新部署的設定）
 * 會影響合法功能，所以系統只產生給人的工單，絕不執行。本模組：
 * - 只接受處置動作政策的 B 級 REQUIRE_APPROVAL 決策，並以 authorizeDungeonqResponseAction
 *   的 CREATE_WORK_ORDER 用途驗證；沒有決策、決策被竄改或用途不符一律拒絕。
 * - 依政策決策的動作代號套用步驟範本；範本只描述人要做的事。
 * - 持久保存工單與狀態（OPEN → IN_PROGRESS → DONE／FAILED／CANCELLED；OPEN 也可直接取消），
 *   由人回報結果，系統透過注入的讀回函式確認。
 * - 不載入任何會改變系統的程式：沒有子程序、網路呼叫或處置連接器。注入的處置紀錄只用來讀取
 *   A 級動作的狀態，讀回函式只用來確認結果。
 *
 * 範本與欄位說明：docs/templates/dungeonq-work-order.md。
 */

export const DUNGEONQ_WORK_ORDER_SCHEMA_VERSION = 'dungeonq-work-order/v1';

const ID_DOMAIN = 'dungeonq-work-order-id/v1';
const SUBJECT_DOMAIN = 'dungeonq-work-order-subject/v1';
const RECORDS_DIRECTORY = 'work-orders';
const EVENTS_FILE = 'work-order-events.jsonl';
const WORK_ORDER_ID_PATTERN = /^wo-[a-f0-9]{24}$/u;
const RECORD_FILE_PATTERN = /^wo-[a-f0-9]{24}\.json$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export class DungeonqWorkOrderError extends Error {
  /**
   * @param {string} code 機器可讀錯誤代碼。
   * @param {Record<string, unknown>} [details] 只放代碼、欄位路徑與計數，不放原始內容。
   */
  constructor(code, details = {}) {
    super(code);
    this.name = 'DungeonqWorkOrderError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new DungeonqWorkOrderError(code, details);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** 所有會重複執行或累積寫入的上限。store 可以調低，不能調高。 */
export const DUNGEONQ_WORK_ORDER_LIMITS = deepFreeze({
  maxWorkOrdersPerIncident: 20,
  maxWorkOrdersPerStore: 500,
  maxReadbackAttempts: 3,
  readbackTimeoutMs: 30_000,
  ledgerTimeoutMs: 5_000,
  maxSensitiveValues: 200,
  minSensitiveValueLength: 6,
  maxSensitiveValueLength: 4_096,
  maxTextLength: 1_000,
  maxListItems: 20,
  maxListItemLength: 200,
  maxReferences: 50,
  maxCounts: 20,
  maxStepNoteLength: 500,
  maxReadbackChecks: 20,
  maxAutomaticActions: 500,
  maxDowntimeMinutes: 10_080
});

export const DUNGEONQ_WORK_ORDER_STATUSES = deepFreeze(['OPEN', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELLED']);

/** 合法狀態轉換。終止狀態不能再轉換。 */
export const DUNGEONQ_WORK_ORDER_TRANSITIONS = deepFreeze({
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'FAILED', 'CANCELLED'],
  DONE: [],
  FAILED: [],
  CANCELLED: []
});

const TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'CANCELLED']);
const READBACK_STATUSES = new Set(['DONE', 'FAILED']);
const VERIFICATION_RESULTS = new Set(['CONFIRMED', 'NOT_CONFIRMED', 'UNKNOWN']);
const CHECK_RESULTS = new Set(['PASS', 'FAIL', 'UNKNOWN']);
const STEP_RESULTS = new Set(['DONE', 'SKIPPED', 'FAILED']);
const AUTOMATIC_ACTION_STATUSES = new Set(['EXECUTED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'FAILED', 'UNKNOWN']);
const AUTOMATIC_ACTION_READBACKS = new Set(['CONFIRMED', 'NOT_CONFIRMED', 'UNKNOWN']);

/** 工單只處理這些義務；遇到其他義務（不認得或屬於 A 級）一律停止。 */
const HANDLED_OBLIGATIONS = new Set([DUNGEONQ_RESPONSE_OBLIGATIONS.createWorkOrder]);

/** 觸發訊號的說明文字，以訊號種類為鍵；不在這裡做任何處置判斷。 */
const TRIGGER_REASONS = deepFreeze({
  WRONG_TICKET_USED: '錯誤 ticket 在入口被使用',
  WRONG_TICKET_SPREAD: '同一張錯誤 ticket 從不同 context 或來源出現（擴散）',
  REAL_ASSET_REQUESTED: '出現對真實資產的請求',
  ACK_TIMEOUT: '告警在時限內沒有人確認'
});

const COMMON_FIRST_STEP = deepFreeze({
  instruction: '核對本工單的事件編號、建議動作與對象和事件摘要頁一致，並確認維護時段與執行人已核准。',
  verify: '事件摘要頁列出同一張工單與同一個對象；維護時段的核准紀錄存在。',
  rollback: '不適用（尚未變更任何系統）。'
});

const COMMON_LAST_STEP = deepFreeze({
  instruction: '在工單回報結果（完成、失敗或取消）與每一步的結果；不要貼上任何密碼、權杖、ticket 原值或個資。',
  verify: '工單狀態已更新；系統讀回結果顯示「已確認」。讀回未確認時，回到對應步驟檢查。',
  rollback: '不適用（只是回報）。'
});

/**
 * B 級步驟範本，以政策目錄的動作代號為鍵。範本只描述人要做的事；本模組不執行任何一步。
 * `{targetId}`、`{assetId}` 由政策決策中從登錄表解析出的對象代入。
 * 修改範本時，同步更新 docs/templates/dungeonq-work-order.md（測試會比對）。
 */
export const DUNGEONQ_WORK_ORDER_TEMPLATES = deepFreeze({
  'B-1': {
    targetKind: 'ACCOUNT',
    title: '停用帳號 {targetId}',
    rationale: '這個帳號可能已被攻擊方取得或濫用。停用可以阻止後續登入與呼叫，但會中斷使用這個帳號的合法使用者或服務，所以由人在維護時段執行。',
    impact: {
      affectedFunctions: [
        '使用這個帳號登入的人或服務無法登入',
        '依賴這個帳號權限的排程、整合或 API 呼叫會失敗'
      ],
      estimatedDowntimeMinutes: { min: 5, max: 30 }
    },
    accessNeeded: [
      '身分管理系統（目錄服務或 IAM）的帳號管理權限',
      '撤銷登入工作階段與存取權杖的權限',
      '已核准的維護時段'
    ],
    steps: [
      {
        instruction: '通知帳號擁有者與依賴這個帳號的服務負責人：即將停用帳號、預估中斷時間與聯絡窗口。',
        verify: '通知送出紀錄存在（只記錄收件角色，不記錄個人聯絡方式）。',
        rollback: '不適用（尚未變更系統）。'
      },
      {
        instruction: '在身分管理系統匯出帳號 {targetId} 目前的狀態、群組與權限，存到私人證據位置並記錄雜湊；不要匯出密碼或金鑰。',
        verify: '證據檔存在，雜湊已寫入事件紀錄。',
        rollback: '不適用（唯讀操作）。'
      },
      {
        instruction: '撤銷帳號 {targetId} 所有有效的登入工作階段與存取權杖。',
        verify: '管理介面查到這個帳號的有效工作階段與權杖數量為 0。',
        rollback: '已撤銷的工作階段不恢復；帳號重新啟用後，合法使用者重新登入即可。'
      },
      {
        instruction: '停用帳號 {targetId}（停用，不要刪除）。',
        verify: '管理介面顯示帳號已停用；用這個帳號測試登入被拒。',
        rollback: '在身分管理系統重新啟用帳號，並依先前匯出的證據恢復群組與權限。'
      },
      {
        instruction: '確認依賴這個帳號的服務已改用替代帳號或已公告暫停，合法使用者健康正常。',
        verify: '合法消費者健康讀回在門檻內；監控沒有非預期錯誤。',
        rollback: '合法功能無法接受中斷時，依停用步驟的回復方式重新啟用帳號，並在工單回報失敗。'
      }
    ]
  },
  'B-2': {
    targetKind: 'SERVICE_SECRET',
    title: '更換主要服務密碼 {targetId}',
    rationale: '這個資料庫或主要服務的密碼可能已外洩。更換後舊密碼失效，但所有使用它的服務都要同步更新設定並重啟，會短暫中斷功能，所以由人在維護時段執行。',
    impact: {
      affectedFunctions: [
        '使用這個密碼的服務在更新設定與重啟前無法連線',
        '重啟期間相關功能短暫中斷'
      ],
      estimatedDowntimeMinutes: { min: 15, max: 60 }
    },
    accessNeeded: [
      '機密管理系統的寫入權限',
      '資料庫或該服務的管理帳號',
      '各相依服務的設定更新與重啟權限',
      '已核准的維護時段'
    ],
    steps: [
      {
        instruction: '盤點所有使用 {targetId} 的服務、排程與整合，排定更新順序與重啟方式，請第二人核對清單。',
        verify: '清單經第二人核對並存入事件紀錄。',
        rollback: '不適用（尚未變更系統）。'
      },
      {
        instruction: '在機密管理系統為 {targetId} 產生新版本密碼；新密碼只存在機密管理系統，不要貼到工單、聊天或信件。',
        verify: '機密管理系統出現新版本，建立時間與執行人正確。',
        rollback: '停用或刪除這個新版本。'
      },
      {
        instruction: '在資料庫或服務端加入新密碼；系統支援時，讓新舊密碼短暫並存。',
        verify: '從管理端以新密碼測試連線成功。',
        rollback: '移除新密碼，回到只有舊密碼的狀態。'
      },
      {
        instruction: '依清單逐一把服務設定改用新版本密碼，並重新載入或重啟。',
        verify: '每個服務的健康檢查通過，錯誤率與延遲在門檻內。',
        rollback: '把該服務的設定改回舊版本密碼並重啟。'
      },
      {
        instruction: '確認全部服務都已改用新密碼後，撤銷舊密碼。',
        verify: '用舊密碼連線被拒；合法消費者健康讀回在門檻內。',
        rollback: '舊密碼撤銷後不恢復；有服務中斷時，回到上一步修正該服務的設定。'
      }
    ]
  },
  'B-3': {
    targetKind: 'HOST',
    title: '重建主機 {targetId}',
    rationale: '這台主機可能已被入侵或被放入攻擊方的程式，不能再信任。重建需要停機或改由備援承接，所以由人執行。',
    impact: {
      affectedFunctions: [
        '這台主機上的服務在重建期間中斷，或改由備援主機承接',
        '主機憑證更換後，依賴舊憑證的連線需要更新'
      ],
      estimatedDowntimeMinutes: { min: 60, max: 240 }
    },
    accessNeeded: [
      '負載平衡或流量管理權限',
      '主機或虛擬化平台的管理權限',
      '已知乾淨的映像與設定管理的存取權限',
      '主機與服務憑證的簽發權限',
      '已核准的維護時段'
    ],
    steps: [
      {
        instruction: '把流量從主機 {targetId} 移走（從負載平衡摘除或暫停排程），由備援承接或公告中斷。',
        verify: '這台主機的新請求數為 0；備援健康正常。',
        rollback: '把主機加回負載平衡或恢復排程。'
      },
      {
        instruction: '保存證據：磁碟快照或映像、日誌匯出，存到私人證據位置並記錄雜湊。',
        verify: '快照與雜湊紀錄存在，第二人可以讀回。',
        rollback: '不適用（只保存證據）。'
      },
      {
        instruction: '從已知乾淨的映像與設定管理重建主機；不要從受影響的主機複製設定、程式或金鑰。',
        verify: '新主機的映像版本與設定和基準清單一致。',
        rollback: '在新主機驗證完成前，保留已隔離、不接流量的舊主機；新主機有問題時停用新主機，繼續由備援承接。'
      },
      {
        instruction: '為新主機簽發新的主機憑證與服務憑證，並撤銷舊憑證。',
        verify: '驗證端拒絕舊憑證；新憑證連線成功。',
        rollback: '舊憑證撤銷後不恢復；新憑證有問題時重新簽發。'
      },
      {
        instruction: '健康檢查通過後，逐步把流量移回新主機。',
        verify: '合法消費者健康讀回在門檻內；監控沒有非預期錯誤。',
        rollback: '再次摘除新主機，流量留在備援。'
      }
    ]
  },
  'B-4': {
    targetKind: 'NETWORK_SEGMENT',
    title: '隔離網段 {targetId}',
    rationale: '攻擊可能已擴散到這個網段。整段隔離可以阻止橫向移動與資料外送，但會中斷網段內外的合法連線，所以由人執行。',
    impact: {
      affectedFunctions: [
        '網段內服務與網段外的連線中斷',
        '需要跨網段的使用者與整合無法使用'
      ],
      estimatedDowntimeMinutes: { min: 15, max: 120 }
    },
    accessNeeded: [
      '防火牆、安全群組或路由的變更權限',
      '網段內主機與服務清單',
      '已核准的維護時段'
    ],
    steps: [
      {
        instruction: '列出網段 {targetId} 內的主機與服務，以及會中斷的上下游連線，請第二人核對。',
        verify: '清單經第二人核對並存入事件紀錄。',
        rollback: '不適用（尚未變更系統）。'
      },
      {
        instruction: '備份目前的防火牆、安全群組與路由設定，並記錄雜湊。',
        verify: '備份檔存在，雜湊已寫入事件紀錄。',
        rollback: '不適用（只做備份）。'
      },
      {
        instruction: '套用隔離規則，只保留管理與證據收集需要的連線。',
        verify: '從網段外測試連線被拒；管理連線仍可用。',
        rollback: '套回先前備份的設定。'
      },
      {
        instruction: '確認合法服務已改走備援或已公告中斷。',
        verify: '合法消費者健康讀回；監控沒有非預期告警。',
        rollback: '合法功能無法接受中斷時，套回備份設定，並在工單回報失敗。'
      }
    ]
  },
  'B-5': {
    targetKind: 'DEPLOYMENT_CONFIG',
    title: '修改並重新部署設定 {targetId}',
    rationale: '這個設定需要變更才能關閉被利用的路徑或端點，而變更必須重新部署，可能短暫中斷服務，所以由人執行。',
    impact: {
      affectedFunctions: [
        '重新部署期間相關服務可能短暫中斷或重啟',
        '設定錯誤可能影響整個服務'
      ],
      estimatedDowntimeMinutes: { min: 15, max: 60 }
    },
    accessNeeded: [
      '版本控制的變更與審查權限',
      '部署系統權限（預備環境與正式環境）',
      '已核准的維護時段'
    ],
    steps: [
      {
        instruction: '在版本控制準備 {targetId} 的設定變更，請第二人審查。',
        verify: '審查核准紀錄存在。',
        rollback: '不合併這個變更。'
      },
      {
        instruction: '先部署到預備環境並驗證。',
        verify: '自動測試通過；預備環境健康檢查正常。',
        rollback: '預備環境回到前一版。'
      },
      {
        instruction: '在維護時段把變更部署到正式環境。',
        verify: '讀回的部署版本等於新版本；健康檢查通過。',
        rollback: '用部署系統回到前一版。'
      },
      {
        instruction: '確認合法消費者的成功率、錯誤率與延遲正常。',
        verify: '合法消費者健康讀回在門檻內。',
        rollback: '回到前一版，並在工單回報失敗。'
      }
    ]
  }
});

/* ------------------------------------------------------------------ */
/* 敏感內容過濾                                                         */
/* ------------------------------------------------------------------ */

const hasMixedCaseAndDigit = (value) => /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /\d/u.test(value);

/** 凍結樣式清單與每一項，但不凍結 RegExp 本身（全域比對需要更新 lastIndex）。 */
function freezePatterns(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

/**
 * 「強」樣式：誤判極少，套用在所有欄位（含識別字）。識別字命中即拒絕；自由文字命中即遮蔽。
 * 每項為 [種類, 樣式, 額外判斷]。
 */
const STRONG_PATTERNS = freezePatterns([
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, null],
  ['URL_CREDENTIAL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/giu, null],
  ['TICKET_OR_TOKEN', /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,}){1,2}/gu, null],
  ['BEARER_TOKEN', /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, null],
  [
    'API_KEY',
    /\b(?:(?:sk|pk|rk)[-_](?:[A-Za-z]{2,8}[-_])?[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})/gu,
    null
  ],
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu, null],
  ['HIGH_ENTROPY', /[A-Za-z0-9+/_-]{32,}={0,2}/gu, hasMixedCaseAndDigit]
]);

/** 只套用在自由文字的個資與憑證樣式（識別字裡的長數字是正常的事件編號）。 */
const TEXT_ONLY_PATTERNS = freezePatterns([
  [
    'CREDENTIAL_ASSIGNMENT',
    /(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|ticket|cookie|session[_-]?id|密碼|口令|金鑰|權杖|票證)\s*["'「]?\s*(?:=|：|:\s)\s*["'「]?[\x21\x23-\x26\x28-\x7E]{4,}/giu,
    null
  ],
  ['NATIONAL_ID', /\b[A-Z][12489]\d{8}\b/gu, null],
  ['PHONE', /(?:\+\d{1,3}[\s-]?\d{1,4}(?:[\s-]?\d{2,4}){2,3}|\b09\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\(0\d{1,2}\)\s?\d{3,4}[\s-]?\d{4}|\b0\d{1,2}-\d{3,4}-?\d{4}\b)/gu, null],
  ['CARD_NUMBER', /\b(?:\d{4}[\s-]){3}\d{1,7}\b/gu, null],
  ['LONG_NUMBER', /(?<![\w./:-])\d{9,}(?![\w-])/gu, null]
]);

const TEXT_PATTERNS = Object.freeze([...STRONG_PATTERNS, ...TEXT_ONLY_PATTERNS]);

function redactionMarker(kind) {
  return `［已遮蔽：${kind}］`;
}

/**
 * 呼叫端提供的敏感原值（例如已簽發的錯誤 ticket、誘餌原文）只留在記憶體中比對，
 * 同時比對其 base64／base64url 形式；不寫入工單、事件或錯誤訊息。
 */
function prepareSensitiveValues(values, limits) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > limits.maxSensitiveValues) {
    fail('WORK_ORDER_SENSITIVE_VALUES_INVALID');
  }
  const variants = new Set();
  for (const value of values) {
    if (
      typeof value !== 'string'
      || value.length < limits.minSensitiveValueLength
      || value.length > limits.maxSensitiveValueLength
    ) {
      fail('WORK_ORDER_SENSITIVE_VALUES_INVALID');
    }
    const bytes = Buffer.from(value, 'utf8');
    for (const variant of [value, bytes.toString('base64'), bytes.toString('base64').replace(/=+$/u, ''), bytes.toString('base64url')]) {
      if (variant.length >= limits.minSensitiveValueLength) variants.add(variant);
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function applyPatterns(text, patterns, onMatch) {
  let output = text;
  for (const [kind, pattern, accept] of patterns) {
    output = output.replace(pattern, (match) => {
      if (accept !== null && !accept(match)) return match;
      return onMatch(kind, match);
    });
  }
  return output;
}

function redactWith(text, sensitiveVariants, patterns) {
  const counts = new Map();
  const add = (kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let output = text;
  for (const variant of sensitiveVariants) {
    if (!output.includes(variant)) continue;
    const parts = output.split(variant);
    for (let index = 1; index < parts.length; index += 1) add('SENSITIVE_VALUE');
    output = parts.join(redactionMarker('SENSITIVE_VALUE'));
  }
  output = applyPatterns(output, patterns, (kind) => {
    add(kind);
    return redactionMarker(kind);
  });
  return { text: output, findings: [...counts].map(([kind, count]) => ({ kind, count })) };
}

function detectStrong(text, sensitiveVariants) {
  const kinds = new Set();
  for (const variant of sensitiveVariants) if (text.includes(variant)) kinds.add('SENSITIVE_VALUE');
  applyPatterns(text, STRONG_PATTERNS, (kind, match) => {
    kinds.add(kind);
    return match;
  });
  return [...kinds];
}

/**
 * 遮蔽自由文字中的憑證、ticket 原值、誘餌原文與個資。M3 摘要頁與 M7 事後報告可共用。
 * 這是樣式比對，無法辨識人名等沒有固定格式的個資；呼叫端仍不得放入這類內容。
 * @param {string} text
 * @param {{ sensitiveValues?: string[] }} [options]
 * @returns {{ text: string, findings: { kind: string, count: number }[] }}
 */
export function redactDungeonqSensitiveText(text, { sensitiveValues = [] } = {}) {
  if (typeof text !== 'string') fail('WORK_ORDER_TEXT_INVALID');
  return redactWith(text, prepareSensitiveValues(sensitiveValues, DUNGEONQ_WORK_ORDER_LIMITS), TEXT_PATTERNS);
}

/* ------------------------------------------------------------------ */
/* 輸入檢查                                                             */
/* ------------------------------------------------------------------ */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIdentifier = (value) => typeof value === 'string' && value.length <= 200 && IDENTIFIER_PATTERN.test(value);
const isIsoDatetime = (value) =>
  typeof value === 'string' && ISO_DATETIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));

function expectKeys(value, allowed, field, code = 'WORK_ORDER_CONTEXT_INVALID') {
  if (!isPlainObject(value)) fail(code, { field, reason: 'object_required' });
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, { field, reason: 'unknown_key' });
  }
  return value;
}

/** 自由文字欄位：限制長度後遮蔽，並記錄遮蔽了哪些種類。 */
function sanitizeText(value, field, maxLength, filter, redactions, code = 'WORK_ORDER_CONTEXT_INVALID') {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail(code, { field, reason: 'text_invalid' });
  }
  const result = redactWith(value.trim(), filter, TEXT_PATTERNS);
  for (const finding of result.findings) redactions.push({ field, ...finding });
  return result.text;
}

function sanitizeTextList(value, field, filter, redactions, limits) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limits.maxListItems) {
    fail('WORK_ORDER_CONTEXT_INVALID', { field, reason: 'list_invalid' });
  }
  return value.map((item, index) =>
    sanitizeText(item, `${field}[${index}]`, limits.maxListItemLength, filter, redactions));
}

/** 識別字欄位不能遮蔽（遮蔽後就失去意義），命中強樣式直接拒絕。 */
function requireCleanIdentifier(value, field, filter, code = 'WORK_ORDER_CONTEXT_INVALID') {
  if (!isIdentifier(value)) fail(code, { field, reason: 'identifier_invalid' });
  const kinds = detectStrong(value, filter);
  if (kinds.length > 0) fail('WORK_ORDER_SENSITIVE_IDENTIFIER', { field, kinds });
  return value;
}

function sanitizeDowntime(value, field, limits) {
  expectKeys(value, ['min', 'max'], field);
  const { min, max } = value;
  if (
    !Number.isSafeInteger(min) || !Number.isSafeInteger(max)
    || min < 0 || max < min || max > limits.maxDowntimeMinutes
  ) {
    fail('WORK_ORDER_CONTEXT_INVALID', { field, reason: 'downtime_invalid' });
  }
  return { min, max };
}

function sanitizeContext(context, filter, limits) {
  const redactions = [];
  expectKeys(context, ['evidence', 'impact', 'requirements'], 'context');
  const evidence = expectKeys(context.evidence, ['summary', 'references', 'counts'], 'context.evidence');
  const references = evidence.references ?? [];
  if (!Array.isArray(references) || references.length > limits.maxReferences) {
    fail('WORK_ORDER_CONTEXT_INVALID', { field: 'context.evidence.references', reason: 'list_invalid' });
  }
  const counts = evidence.counts ?? {};
  if (!isPlainObject(counts) || Object.keys(counts).length > limits.maxCounts) {
    fail('WORK_ORDER_CONTEXT_INVALID', { field: 'context.evidence.counts', reason: 'object_invalid' });
  }
  const sanitizedCounts = {};
  for (const [key, count] of Object.entries(counts)) {
    requireCleanIdentifier(key, 'context.evidence.counts', filter);
    if (!Number.isSafeInteger(count) || count < 0) {
      fail('WORK_ORDER_CONTEXT_INVALID', { field: 'context.evidence.counts', reason: 'count_invalid' });
    }
    sanitizedCounts[key] = count;
  }
  const impact = expectKeys(
    context.impact ?? {},
    ['affectedFunctions', 'affectedUserGroups', 'estimatedDowntimeMinutes', 'notes'],
    'context.impact'
  );
  const requirements = expectKeys(
    context.requirements ?? {},
    ['adminAccountRole', 'maintenanceWindow', 'notes'],
    'context.requirements'
  );
  let maintenanceWindow = null;
  if (requirements.maintenanceWindow !== undefined && requirements.maintenanceWindow !== null) {
    const window = expectKeys(requirements.maintenanceWindow, ['start', 'end'], 'context.requirements.maintenanceWindow');
    if (!isIsoDatetime(window.start) || !isIsoDatetime(window.end) || Date.parse(window.end) <= Date.parse(window.start)) {
      fail('WORK_ORDER_CONTEXT_INVALID', { field: 'context.requirements.maintenanceWindow', reason: 'window_invalid' });
    }
    maintenanceWindow = { start: window.start, end: window.end };
  }
  return {
    redactions,
    evidence: {
      summary: sanitizeText(evidence.summary, 'context.evidence.summary', limits.maxTextLength, filter, redactions),
      references: references.map((reference, index) =>
        requireCleanIdentifier(reference, `context.evidence.references[${index}]`, filter)),
      counts: sanitizedCounts
    },
    impact: {
      affectedFunctions: sanitizeTextList(impact.affectedFunctions, 'context.impact.affectedFunctions', filter, redactions, limits),
      affectedUserGroups: sanitizeTextList(impact.affectedUserGroups, 'context.impact.affectedUserGroups', filter, redactions, limits),
      estimatedDowntimeMinutes: impact.estimatedDowntimeMinutes === undefined
        ? null
        : sanitizeDowntime(impact.estimatedDowntimeMinutes, 'context.impact.estimatedDowntimeMinutes', limits),
      notes: impact.notes === undefined
        ? null
        : sanitizeText(impact.notes, 'context.impact.notes', limits.maxTextLength, filter, redactions)
    },
    requirements: {
      adminAccountRole: requirements.adminAccountRole === undefined
        ? null
        : sanitizeText(requirements.adminAccountRole, 'context.requirements.adminAccountRole', limits.maxListItemLength, filter, redactions),
      maintenanceWindow,
      notes: requirements.notes === undefined
        ? null
        : sanitizeText(requirements.notes, 'context.requirements.notes', limits.maxTextLength, filter, redactions)
    }
  };
}

/** 寫入前的最後檢查：除了政策摘要（十六進位雜湊）以外，所有字串都不能命中強樣式。 */
const FINAL_SCAN_SKIPPED_KEYS = new Set(['policy', 'idempotencyKey', 'subjectKey']);

function assertNoSensitiveContent(record, filter) {
  const visit = (value, path) => {
    if (typeof value === 'string') {
      const kinds = detectStrong(value, filter);
      if (kinds.length > 0) fail('WORK_ORDER_SENSITIVE_CONTENT', { field: path, kinds });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (path === '' && FINAL_SCAN_SKIPPED_KEYS.has(key)) continue;
        visit(nested, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  visit(record, '');
}

/* ------------------------------------------------------------------ */
/* 政策決策                                                             */
/* ------------------------------------------------------------------ */

/**
 * 只接受 B 級 REQUIRE_APPROVAL 決策：交給政策的授權函式驗證（摘要、重新判定、請求一致、用途），
 * 再確認義務都是工單能履行的。這裡不自行判斷效果或級別。
 */
function authorizeWorkOrder({ decision, input, request }) {
  if (decision === undefined || decision === null) fail('WORK_ORDER_DECISION_REQUIRED');
  let copies;
  try {
    copies = structuredClone({ decision, input, request });
  } catch {
    fail('WORK_ORDER_NOT_AUTHORIZED', { reason: 'decision_malformed' });
  }
  if (!isPlainObject(copies.request)) fail('WORK_ORDER_NOT_AUTHORIZED', { reason: 'request_mismatch' });
  const authorization = authorizeDungeonqResponseAction({
    decision: copies.decision,
    input: copies.input,
    request: {
      incidentId: copies.request.incidentId,
      actionCode: copies.request.actionCode,
      targetId: copies.request.targetId
    },
    purpose: 'CREATE_WORK_ORDER'
  });
  if (!authorization.authorized) fail('WORK_ORDER_NOT_AUTHORIZED', { reason: authorization.reason });
  const approved = authorization.decision;
  const obligations = approved.obligations;
  if (
    !obligations.includes(DUNGEONQ_RESPONSE_OBLIGATIONS.createWorkOrder)
    || obligations.some((obligation) => !HANDLED_OBLIGATIONS.has(obligation))
  ) {
    fail('WORK_ORDER_OBLIGATION_UNSUPPORTED');
  }
  return { decision: approved, input: copies.input };
}

function digest(domain, value) {
  return createHash('sha256').update(`${domain}\n${value}`).digest('hex');
}

function workOrderIdFor(decisionDigest) {
  return `wo-${digest(ID_DOMAIN, decisionDigest).slice(0, 24)}`;
}

function subjectKeyFor(decision) {
  return digest(SUBJECT_DOMAIN, JSON.stringify([decision.incidentId, decision.actionCode, decision.target.targetId]));
}

/* ------------------------------------------------------------------ */
/* A 級動作快照                                                         */
/* ------------------------------------------------------------------ */

/** 有上限、無重試的單次呼叫；逾時會中止並回傳結果不明。 */
async function boundedCall(call, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((settle) => {
    timer = setTimeout(() => {
      controller.abort();
      settle({ ok: false, reason: 'TIMEOUT' });
    }, timeoutMs);
  });
  try {
    const attempt = Promise.resolve()
      .then(() => call(controller.signal))
      .then((value) => ({ ok: true, value }), () => ({ ok: false, reason: 'FAILED' }));
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function actionNameOf(actionCode) {
  return getDungeonqResponseActionCatalogEntry(actionCode)?.name ?? null;
}

function validateLedgerRecords(value, filter, limits) {
  if (!Array.isArray(value) || value.length > limits.maxAutomaticActions) return null;
  const records = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    const entry = getDungeonqResponseActionCatalogEntry(item.actionCode);
    if (entry === null || entry.actionClass !== 'A') return null;
    if (!isIdentifier(item.targetId) || detectStrong(item.targetId, filter).length > 0) return null;
    const readback = item.readback ?? 'UNKNOWN';
    if (!AUTOMATIC_ACTION_STATUSES.has(item.status) || !AUTOMATIC_ACTION_READBACKS.has(readback)) return null;
    if (item.recordedAt !== undefined && item.recordedAt !== null && !isIsoDatetime(item.recordedAt)) return null;
    records.push({
      actionCode: entry.code,
      targetId: item.targetId,
      status: item.status,
      readback,
      recordedAt: item.recordedAt ?? null
    });
  }
  return records;
}

/**
 * 建立當下的 A 級動作快照：清單以政策輸入的 incidentExecutions 為準，狀態取自注入的處置紀錄
 * （只讀）。處置紀錄缺漏或讀取失敗時，狀態一律標為 UNKNOWN，不猜測。
 */
async function snapshotAutomaticActions({ input, incidentId, responseLedger, filter, limits, capturedAt }) {
  let source = 'LEDGER_NOT_CONFIGURED';
  let records = [];
  if (responseLedger !== null) {
    const result = await boundedCall(
      (signal) => responseLedger.listIncidentActions({ incidentId, signal }),
      limits.ledgerTimeoutMs
    );
    if (!result.ok) {
      source = 'LEDGER_UNAVAILABLE';
    } else {
      const validated = validateLedgerRecords(result.value, filter, limits);
      source = validated === null ? 'LEDGER_INVALID' : 'LEDGER';
      records = validated ?? [];
    }
  }
  const remaining = [...records];
  const items = [];
  for (const execution of input.incidentExecutions) {
    const index = remaining.findIndex((record) =>
      record.actionCode === execution.actionCode && record.targetId === execution.targetId);
    const match = index >= 0 ? remaining.splice(index, 1)[0] : null;
    items.push({
      actionCode: execution.actionCode,
      actionName: actionNameOf(execution.actionCode),
      targetId: execution.targetId,
      assetId: execution.assetId,
      status: match?.status ?? 'UNKNOWN',
      readback: match?.readback ?? 'UNKNOWN',
      recordedAt: match?.recordedAt ?? null,
      inPolicyInput: true,
      inLedger: match !== null
    });
  }
  for (const record of remaining) {
    items.push({
      actionCode: record.actionCode,
      actionName: actionNameOf(record.actionCode),
      targetId: record.targetId,
      assetId: null,
      status: record.status,
      readback: record.readback,
      recordedAt: record.recordedAt,
      inPolicyInput: false,
      inLedger: true
    });
  }
  return { capturedAt, source, items };
}

/* ------------------------------------------------------------------ */
/* 工單內容                                                             */
/* ------------------------------------------------------------------ */

function fillTarget(text, target) {
  return text.replaceAll('{targetId}', target.targetId).replaceAll('{assetId}', target.assetId);
}

function buildRecord({ workOrderId, decision, context, automaticActions, createdAt }) {
  const template = DUNGEONQ_WORK_ORDER_TEMPLATES[decision.actionCode];
  if (template === undefined) fail('WORK_ORDER_TEMPLATE_MISSING');
  if (template.targetKind !== decision.target.kind) fail('WORK_ORDER_TEMPLATE_MISMATCH');
  const target = decision.target;
  const steps = [COMMON_FIRST_STEP, ...template.steps, COMMON_LAST_STEP].map((step, index) => ({
    index: index + 1,
    instruction: fillTarget(step.instruction, target),
    verify: fillTarget(step.verify, target),
    rollback: fillTarget(step.rollback, target)
  }));
  const downtime = context.impact.estimatedDowntimeMinutes;
  return {
    schemaVersion: DUNGEONQ_WORK_ORDER_SCHEMA_VERSION,
    workOrderId,
    idempotencyKey: decision.decisionDigest,
    subjectKey: subjectKeyFor(decision),
    revision: 1,
    status: 'OPEN',
    createdAt,
    updatedAt: createdAt,
    systemExecution: 'NONE',
    incident: { incidentId: decision.incidentId, traceId: decision.traceId },
    trigger: {
      signalKind: decision.signal.kind,
      signalEventId: decision.signal.eventId,
      reason: TRIGGER_REASONS[decision.signal.kind] ?? '未列出的訊號，請查事件紀錄',
      evidence: {
        summary: context.evidence.summary,
        references: context.evidence.references.length > 0
          ? context.evidence.references
          : [decision.signal.eventId],
        counts: context.evidence.counts
      }
    },
    recommendation: {
      actionCode: decision.actionCode,
      actionName: actionNameOf(decision.actionCode),
      title: fillTarget(template.title, target),
      rationale: fillTarget(template.rationale, target)
    },
    target: { targetId: target.targetId, kind: target.kind, assetId: target.assetId },
    impact: {
      affectedFunctions: [...template.impact.affectedFunctions, ...context.impact.affectedFunctions],
      affectedUserGroups: context.impact.affectedUserGroups,
      estimatedDowntimeMinutes: downtime === null
        ? { ...template.impact.estimatedDowntimeMinutes, source: 'TEMPLATE_DEFAULT' }
        : { ...downtime, source: 'OPERATOR_PROVIDED' },
      notes: context.impact.notes
    },
    steps,
    requirements: {
      accessNeeded: [...template.accessNeeded],
      adminAccountRole: context.requirements.adminAccountRole,
      maintenanceWindow: context.requirements.maintenanceWindow,
      notes: context.requirements.notes
    },
    automaticActions,
    policy: {
      policyVersion: decision.policyVersion,
      catalogDigest: decision.catalogDigest,
      registryDigest: decision.registryDigest,
      inputDigest: decision.inputDigest,
      decisionDigest: decision.decisionDigest,
      effect: decision.effect,
      reason: decision.reason,
      obligations: [...decision.obligations]
    },
    history: [{ from: null, to: 'OPEN', at: createdAt, actor: 'system', actorVerified: false, note: null }],
    humanReport: null,
    verification: {
      status: 'NOT_STARTED',
      reason: null,
      attempts: 0,
      lastCheckedAt: null,
      checks: [],
      exhausted: false
    },
    contentFilter: { redactions: context.redactions }
  };
}

/* ------------------------------------------------------------------ */
/* 持久化                                                               */
/* ------------------------------------------------------------------ */

function writeDurableFile(path, text) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function temporaryPathFor(path) {
  return `${path}.${randomBytes(8).toString('hex')}.tmp`;
}

/** 預設儲存：每次操作只嘗試一次，失敗就丟出，不重試。 */
export const dungeonqWorkOrderNodeStorage = Object.freeze({
  ensurePrivateDirectory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      fail('WORK_ORDER_DIRECTORY_NOT_PRIVATE');
    }
  },
  /** 只在檔案不存在時建立；已存在回傳 false。 */
  createExclusive(path, text) {
    const temporary = temporaryPathFor(path);
    writeDurableFile(temporary, text);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // 暫存檔清除失敗不影響工單本身；下次操作會用新的暫存檔名。
      }
    }
    syncDirectory(dirname(path));
    return true;
  },
  replace(path, text) {
    const temporary = temporaryPathFor(path);
    writeDurableFile(temporary, text);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  },
  append(path, line) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      appendFileSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  /** 檔案不存在回傳 null。 */
  read(path) {
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  },
  list(path) {
    return readdirSync(path);
  }
});

function storageCall(operation, call) {
  try {
    return call();
  } catch (error) {
    if (error instanceof DungeonqWorkOrderError) throw error;
    const errno = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : null;
    return fail('WORK_ORDER_STORAGE_UNAVAILABLE', { operation, errno });
  }
}

function effectiveLimits(overrides) {
  if (overrides === undefined || overrides === null) return DUNGEONQ_WORK_ORDER_LIMITS;
  if (!isPlainObject(overrides)) fail('WORK_ORDER_LIMITS_INVALID');
  const merged = { ...DUNGEONQ_WORK_ORDER_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DUNGEONQ_WORK_ORDER_LIMITS, key) || !Number.isSafeInteger(value) || value < 1) {
      fail('WORK_ORDER_LIMITS_INVALID');
    }
    // 下限類設定（最短敏感值長度）只能調高，其他上限只能調低。
    merged[key] = key === 'minSensitiveValueLength'
      ? Math.max(DUNGEONQ_WORK_ORDER_LIMITS[key], value)
      : Math.min(DUNGEONQ_WORK_ORDER_LIMITS[key], value);
  }
  return deepFreeze(merged);
}

/* ------------------------------------------------------------------ */
/* 工單儲存與狀態                                                       */
/* ------------------------------------------------------------------ */

/**
 * 開啟工單儲存。目錄必須是私人目錄（0700、不是符號連結）。同一目錄只能由一個主機程序寫入。
 *
 * @param {object} options
 * @param {string} options.directory 私人工單目錄。
 * @param {() => string} [options.clock] 回傳 ISO 8601 UTC 時間。
 * @param {null | ((args: { workOrder: object, signal: AbortSignal }) => Promise<{ status: 'CONFIRMED'|'NOT_CONFIRMED'|'UNKNOWN', checks?: { name: string, status: 'PASS'|'FAIL'|'UNKNOWN', note?: string }[] }>)} [options.readback]
 *   系統讀回確認函式；之後的里程碑接上實際檢查。只能讀取，不能變更系統。
 * @param {null | { listIncidentActions(args: { incidentId: string, signal: AbortSignal }): Promise<object[]> }} [options.responseLedger]
 *   A 級處置紀錄（M5 連接器）；本模組只呼叫 listIncidentActions。
 * @param {typeof dungeonqWorkOrderNodeStorage} [options.storage] 測試用的儲存替身。
 * @param {Partial<typeof DUNGEONQ_WORK_ORDER_LIMITS>} [options.limits] 只能調低的上限。
 */
export function openDungeonqWorkOrderStore({
  directory,
  clock = () => new Date().toISOString(),
  readback = null,
  responseLedger = null,
  storage = dungeonqWorkOrderNodeStorage,
  limits: limitOverrides
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) fail('WORK_ORDER_DIRECTORY_REQUIRED');
  if (readback !== null && typeof readback !== 'function') fail('WORK_ORDER_READBACK_INVALID');
  if (responseLedger !== null && typeof responseLedger?.listIncidentActions !== 'function') {
    fail('WORK_ORDER_LEDGER_INVALID');
  }
  const limits = effectiveLimits(limitOverrides);
  const root = resolve(directory);
  const recordsDirectory = join(root, RECORDS_DIRECTORY);
  const eventsPath = join(root, EVENTS_FILE);
  storageCall('ensure_directory', () => storage.ensurePrivateDirectory(root));
  storageCall('ensure_directory', () => storage.ensurePrivateDirectory(recordsDirectory));
  const verifying = new Set();

  const now = () => {
    const value = clock();
    if (!isIsoDatetime(value)) fail('WORK_ORDER_CLOCK_INVALID');
    return value;
  };
  const recordPath = (workOrderId) => join(recordsDirectory, `${workOrderId}.json`);
  const serialize = (record) => `${JSON.stringify(record, null, 2)}\n`;

  function parseRecord(text, workOrderId) {
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      fail('WORK_ORDER_RECORD_CORRUPT', { workOrderId });
    }
    if (
      !isPlainObject(record)
      || record.schemaVersion !== DUNGEONQ_WORK_ORDER_SCHEMA_VERSION
      || record.workOrderId !== workOrderId
      || !DUNGEONQ_WORK_ORDER_STATUSES.includes(record.status)
      || !Number.isSafeInteger(record.revision)
    ) {
      fail('WORK_ORDER_RECORD_CORRUPT', { workOrderId });
    }
    return record;
  }

  function readRecord(workOrderId) {
    const text = storageCall('read', () => storage.read(recordPath(workOrderId)));
    return text === null ? null : parseRecord(text, workOrderId);
  }

  function requireRecord(workOrderId) {
    if (typeof workOrderId !== 'string' || !WORK_ORDER_ID_PATTERN.test(workOrderId)) {
      fail('WORK_ORDER_ID_INVALID');
    }
    return readRecord(workOrderId) ?? fail('WORK_ORDER_NOT_FOUND', { workOrderId });
  }

  function listRecords() {
    const names = storageCall('list', () => storage.list(recordsDirectory))
      .filter((name) => RECORD_FILE_PATTERN.test(name))
      .sort();
    if (names.length > limits.maxWorkOrdersPerStore) fail('WORK_ORDER_STORE_OVER_LIMIT');
    return names.map((name) => readRecord(name.slice(0, -'.json'.length))).filter((record) => record !== null);
  }

  /** 稽核事件只放代碼、識別字與時間，不放自由文字。 */
  function appendEvent(event) {
    storageCall('append_event', () => storage.append(eventsPath, `${JSON.stringify(event)}\n`));
  }

  /**
   * 由 B 級政策決策產生工單。同一決策（決策摘要）只會產生一張；同一事件、同一動作、同一對象
   * 已有未結束的工單時，回傳既有工單，不另開新單。
   *
   * @returns {Promise<{ created: boolean, deduplicatedBy: null | 'IDEMPOTENCY_KEY' | 'ACTIVE_SUBJECT', workOrder: object }>}
   */
  async function create({ decision, input, request, context, sensitiveValues } = {}) {
    const authorized = authorizeWorkOrder({ decision, input, request });
    const approved = authorized.decision;
    const workOrderId = workOrderIdFor(approved.decisionDigest);
    const existing = readRecord(workOrderId);
    if (existing !== null) return { created: false, deduplicatedBy: 'IDEMPOTENCY_KEY', workOrder: existing };

    const filter = prepareSensitiveValues(sensitiveValues, limits);
    requireCleanIdentifier(approved.incidentId, 'decision.incidentId', filter, 'WORK_ORDER_NOT_AUTHORIZED');
    requireCleanIdentifier(approved.traceId, 'decision.traceId', filter, 'WORK_ORDER_NOT_AUTHORIZED');
    requireCleanIdentifier(approved.signal.eventId, 'decision.signal.eventId', filter, 'WORK_ORDER_NOT_AUTHORIZED');
    requireCleanIdentifier(approved.target.targetId, 'decision.target.targetId', filter, 'WORK_ORDER_NOT_AUTHORIZED');
    requireCleanIdentifier(approved.target.assetId, 'decision.target.assetId', filter, 'WORK_ORDER_NOT_AUTHORIZED');
    const sanitizedContext = sanitizeContext(context, filter, limits);
    const createdAt = now();
    const automaticActions = await snapshotAutomaticActions({
      input: authorized.input,
      incidentId: approved.incidentId,
      responseLedger,
      filter,
      limits,
      capturedAt: createdAt
    });
    const record = buildRecord({ workOrderId, decision: approved, context: sanitizedContext, automaticActions, createdAt });
    assertNoSensitiveContent(record, filter);

    // 以下到寫入為止都是同步操作，同一程序內不會交錯。
    const replay = readRecord(workOrderId);
    if (replay !== null) return { created: false, deduplicatedBy: 'IDEMPOTENCY_KEY', workOrder: replay };
    const records = listRecords();
    const active = records.find((candidate) =>
      candidate.subjectKey === record.subjectKey && !TERMINAL_STATUSES.has(candidate.status));
    if (active !== undefined) return { created: false, deduplicatedBy: 'ACTIVE_SUBJECT', workOrder: active };
    if (records.length >= limits.maxWorkOrdersPerStore) {
      fail('WORK_ORDER_LIMIT_REACHED', { scope: 'store', limit: limits.maxWorkOrdersPerStore });
    }
    const incidentCount = records.filter((candidate) => candidate.incident?.incidentId === approved.incidentId).length;
    if (incidentCount >= limits.maxWorkOrdersPerIncident) {
      fail('WORK_ORDER_LIMIT_REACHED', { scope: 'incident', limit: limits.maxWorkOrdersPerIncident });
    }
    const written = storageCall('create_record', () => storage.createExclusive(recordPath(workOrderId), serialize(record)));
    if (!written) return { created: false, deduplicatedBy: 'IDEMPOTENCY_KEY', workOrder: requireRecord(workOrderId) };
    appendEvent({
      kind: 'WORK_ORDER_CREATED',
      at: createdAt,
      workOrderId,
      incidentId: approved.incidentId,
      actionCode: approved.actionCode,
      targetId: approved.target.targetId,
      decisionDigest: approved.decisionDigest,
      revision: record.revision
    });
    return { created: true, deduplicatedBy: null, workOrder: record };
  }

  function sanitizeStepResults(stepResults, record, filter, redactions) {
    if (stepResults === undefined) return [];
    if (!Array.isArray(stepResults) || stepResults.length > record.steps.length) {
      fail('WORK_ORDER_REPORT_INVALID', { field: 'stepResults', reason: 'list_invalid' });
    }
    const seen = new Set();
    return stepResults.map((result, position) => {
      const field = `stepResults[${position}]`;
      expectKeys(result, ['index', 'status', 'note'], field, 'WORK_ORDER_REPORT_INVALID');
      if (
        !Number.isSafeInteger(result.index) || result.index < 1 || result.index > record.steps.length
        || seen.has(result.index) || !STEP_RESULTS.has(result.status)
      ) {
        fail('WORK_ORDER_REPORT_INVALID', { field, reason: 'step_result_invalid' });
      }
      seen.add(result.index);
      return {
        index: result.index,
        status: result.status,
        note: result.note === undefined
          ? null
          : sanitizeText(result.note, `${field}.note`, limits.maxStepNoteLength, filter, redactions, 'WORK_ORDER_REPORT_INVALID')
      };
    });
  }

  /** 由人推進狀態。expectedRevision 必須等於目前版本，避免覆蓋別人的更新。 */
  function transition(workOrderId, to, { expectedRevision, actor, note, stepResults, sensitiveValues } = {}) {
    const record = requireRecord(workOrderId);
    if (!Number.isSafeInteger(expectedRevision)) fail('WORK_ORDER_EXPECTED_REVISION_REQUIRED');
    if (record.revision !== expectedRevision) {
      fail('WORK_ORDER_REVISION_CONFLICT', { workOrderId, currentRevision: record.revision });
    }
    if (!DUNGEONQ_WORK_ORDER_TRANSITIONS[record.status].includes(to)) {
      fail('WORK_ORDER_TRANSITION_INVALID', { workOrderId, from: record.status, to });
    }
    const filter = prepareSensitiveValues(sensitiveValues, limits);
    requireCleanIdentifier(actor, 'actor', filter, 'WORK_ORDER_REPORT_INVALID');
    const redactions = [];
    const sanitizedNote = note === undefined || note === null
      ? null
      : sanitizeText(note, 'note', limits.maxTextLength, filter, redactions, 'WORK_ORDER_REPORT_INVALID');
    const terminal = TERMINAL_STATUSES.has(to);
    if (!terminal && stepResults !== undefined) {
      fail('WORK_ORDER_REPORT_INVALID', { field: 'stepResults', reason: 'only_for_final_report' });
    }
    const sanitizedSteps = sanitizeStepResults(stepResults, record, filter, redactions);
    const at = now();
    const next = structuredClone(record);
    next.status = to;
    next.revision = record.revision + 1;
    next.updatedAt = at;
    // 操作者身分由呼叫端提供，尚未驗證；M3 的已驗證登入接上後改為驗證後的帳號。
    next.history.push({ from: record.status, to, at, actor, actorVerified: false, note: sanitizedNote });
    if (terminal) {
      next.humanReport = {
        result: to,
        reportedBy: actor,
        actorVerified: false,
        reportedAt: at,
        note: sanitizedNote,
        stepResults: sanitizedSteps
      };
    }
    next.contentFilter.redactions.push(...redactions);
    assertNoSensitiveContent(next, filter);
    storageCall('update_record', () => storage.replace(recordPath(workOrderId), serialize(next)));
    appendEvent({
      kind: 'WORK_ORDER_TRANSITION',
      at,
      workOrderId,
      incidentId: record.incident.incidentId,
      from: record.status,
      to,
      actor,
      revision: next.revision
    });
    return next;
  }

  function validateReadbackResult(value, filter, redactions) {
    if (!isPlainObject(value) || !VERIFICATION_RESULTS.has(value.status)) return null;
    const checks = value.checks ?? [];
    if (!Array.isArray(checks) || checks.length > limits.maxReadbackChecks) return null;
    const sanitizedChecks = [];
    for (const [position, check] of checks.entries()) {
      if (!isPlainObject(check) || !isIdentifier(check.name) || !CHECK_RESULTS.has(check.status)) return null;
      if (detectStrong(check.name, filter).length > 0) return null;
      let note = null;
      if (check.note !== undefined) {
        if (typeof check.note !== 'string' || check.note.trim().length === 0 || check.note.length > limits.maxListItemLength) {
          return null;
        }
        const redacted = redactWith(check.note.trim(), filter, TEXT_PATTERNS);
        note = redacted.text;
        for (const finding of redacted.findings) {
          redactions.push({ field: `verification.checks[${position}].note`, ...finding });
        }
      }
      sanitizedChecks.push({ name: check.name, status: check.status, note });
    }
    return { status: value.status, checks: sanitizedChecks };
  }

  /**
   * 系統讀回確認：只在人回報 DONE 或 FAILED 後執行，每次呼叫只讀回一次，不自動重試；
   * 每張工單最多 maxReadbackAttempts 次，用完就停止並標記 exhausted，交給人處理。
   * 讀回失敗、逾時或格式不符時記為 UNKNOWN，不推定成功。
   */
  async function verify(workOrderId, { sensitiveValues } = {}) {
    const record = requireRecord(workOrderId);
    if (readback === null) fail('WORK_ORDER_READBACK_NOT_CONFIGURED');
    if (!READBACK_STATUSES.has(record.status)) {
      fail('WORK_ORDER_READBACK_NOT_ALLOWED', { workOrderId, status: record.status });
    }
    if (record.verification.status === 'CONFIRMED') return record;
    if (record.verification.attempts >= limits.maxReadbackAttempts) {
      fail('WORK_ORDER_READBACK_LIMIT_REACHED', { workOrderId, limit: limits.maxReadbackAttempts });
    }
    if (verifying.has(workOrderId)) fail('WORK_ORDER_READBACK_IN_PROGRESS', { workOrderId });
    const filter = prepareSensitiveValues(sensitiveValues, limits);
    verifying.add(workOrderId);
    try {
      const snapshot = deepFreeze(structuredClone(record));
      const result = await boundedCall((signal) => readback({ workOrder: snapshot, signal }), limits.readbackTimeoutMs);
      const redactions = [];
      let outcome;
      if (!result.ok) {
        outcome = { status: 'UNKNOWN', reason: result.reason === 'TIMEOUT' ? 'READBACK_TIMEOUT' : 'READBACK_FAILED', checks: [] };
      } else {
        const validated = validateReadbackResult(result.value, filter, redactions);
        outcome = validated === null
          ? { status: 'UNKNOWN', reason: 'READBACK_RESULT_INVALID', checks: [] }
          : { ...validated, reason: `READBACK_${validated.status}` };
      }
      const latest = requireRecord(workOrderId);
      if (latest.revision !== record.revision) {
        fail('WORK_ORDER_REVISION_CONFLICT', { workOrderId, currentRevision: latest.revision });
      }
      const at = now();
      const attempts = record.verification.attempts + 1;
      const next = structuredClone(latest);
      next.revision = latest.revision + 1;
      next.updatedAt = at;
      next.verification = {
        status: outcome.status,
        reason: outcome.reason,
        attempts,
        lastCheckedAt: at,
        checks: outcome.checks,
        exhausted: outcome.status !== 'CONFIRMED' && attempts >= limits.maxReadbackAttempts
      };
      next.contentFilter.redactions.push(...redactions);
      assertNoSensitiveContent(next, filter);
      storageCall('update_record', () => storage.replace(recordPath(workOrderId), serialize(next)));
      appendEvent({
        kind: 'WORK_ORDER_READBACK',
        at,
        workOrderId,
        incidentId: latest.incident.incidentId,
        result: outcome.status,
        reason: outcome.reason,
        attempt: attempts,
        revision: next.revision
      });
      return next;
    } finally {
      verifying.delete(workOrderId);
    }
  }

  /** M3 摘要頁用：列出事件的工單與狀態，不含步驟細節。連結以 workOrderId 或 ref 組成。 */
  function summarizeIncident(incidentId) {
    if (!isIdentifier(incidentId)) fail('WORK_ORDER_INCIDENT_INVALID');
    const records = listRecords()
      .filter((record) => record.incident.incidentId === incidentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.workOrderId.localeCompare(right.workOrderId));
    const counts = Object.fromEntries(DUNGEONQ_WORK_ORDER_STATUSES.map((status) => [status, 0]));
    for (const record of records) counts[record.status] += 1;
    return {
      incidentId,
      counts,
      pendingCount: counts.OPEN + counts.IN_PROGRESS,
      allTerminal: records.every((record) => TERMINAL_STATUSES.has(record.status)),
      unverifiedReportCount: records.filter((record) =>
        READBACK_STATUSES.has(record.status) && record.verification.status !== 'CONFIRMED').length,
      workOrders: records.map((record) => ({
        workOrderId: record.workOrderId,
        ref: `dungeonq-work-order:${record.workOrderId}`,
        actionCode: record.recommendation.actionCode,
        actionName: record.recommendation.actionName,
        title: record.recommendation.title,
        targetId: record.target.targetId,
        status: record.status,
        verification: record.verification.status,
        verificationExhausted: record.verification.exhausted,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }))
    };
  }

  return Object.freeze({
    create,
    /** OPEN → IN_PROGRESS。 */
    start: (workOrderId, options) => transition(workOrderId, 'IN_PROGRESS', options),
    /** IN_PROGRESS → DONE／FAILED，由人回報執行結果。 */
    report: (workOrderId, { result, ...options } = {}) => {
      if (!READBACK_STATUSES.has(result)) fail('WORK_ORDER_REPORT_INVALID', { field: 'result', reason: 'result_invalid' });
      return transition(workOrderId, result, options);
    },
    /** OPEN 或 IN_PROGRESS → CANCELLED。 */
    cancel: (workOrderId, options) => transition(workOrderId, 'CANCELLED', options),
    verify,
    get: (workOrderId) => requireRecord(workOrderId),
    listByIncident: (incidentId) => {
      if (!isIdentifier(incidentId)) fail('WORK_ORDER_INCIDENT_INVALID');
      return listRecords().filter((record) => record.incident.incidentId === incidentId);
    },
    summarizeIncident,
    render: (workOrderId) => renderDungeonqWorkOrderMarkdown(requireRecord(workOrderId))
  });
}

/* ------------------------------------------------------------------ */
/* 給人看的 Markdown                                                     */
/* ------------------------------------------------------------------ */

const STATUS_LABELS = deepFreeze({
  OPEN: '待處理',
  IN_PROGRESS: '執行中',
  DONE: '人回報完成',
  FAILED: '人回報失敗',
  CANCELLED: '已取消'
});
const VERIFICATION_LABELS = deepFreeze({
  NOT_STARTED: '尚未讀回',
  CONFIRMED: '已確認',
  NOT_CONFIRMED: '讀回未確認',
  UNKNOWN: '讀回結果不明'
});
const AUTOMATIC_STATUS_LABELS = deepFreeze({
  EXECUTED: '已執行',
  ROLLED_BACK: '已回復',
  ROLLBACK_FAILED: '回復失敗',
  FAILED: '執行失敗',
  UNKNOWN: '狀態不明'
});
const AUTOMATIC_SOURCE_LABELS = deepFreeze({
  LEDGER: '處置紀錄',
  LEDGER_NOT_CONFIGURED: '尚未接上處置紀錄，狀態不明',
  LEDGER_UNAVAILABLE: '處置紀錄讀取失敗，狀態不明',
  LEDGER_INVALID: '處置紀錄格式不符，狀態不明'
});
const STEP_RESULT_LABELS = deepFreeze({ DONE: '完成', SKIPPED: '略過', FAILED: '失敗' });
const CHECK_RESULT_LABELS = deepFreeze({ PASS: '通過', FAIL: '未通過', UNKNOWN: '不明' });

function inline(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|');
}

function bulletList(items, empty) {
  return items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${inline(item)}`);
}

/**
 * 把工單轉成給人看的 Markdown，章節順序與 docs/templates/dungeonq-work-order.md 相同。
 * 內容只來自已過濾的工單紀錄。
 */
export function renderDungeonqWorkOrderMarkdown(record) {
  const downtime = record.impact.estimatedDowntimeMinutes;
  const window = record.requirements.maintenanceWindow;
  const counts = Object.entries(record.trigger.evidence.counts).map(([key, count]) => `${key}：${count}`);
  const lines = [
    `# DungeonQ B 級工單 ${inline(record.workOrderId)}`,
    '',
    '> 本工單只列出需要人執行的步驟。系統沒有執行、也不會自動執行這些變更。',
    '',
    `- 狀態：${STATUS_LABELS[record.status]}（版本 ${record.revision}）`,
    `- 系統讀回：${VERIFICATION_LABELS[record.verification.status]}（已讀回 ${record.verification.attempts} 次）`,
    `- 事件編號：${inline(record.incident.incidentId)}`,
    `- 建立時間：${inline(record.createdAt)}；最後更新：${inline(record.updatedAt)}`,
    '',
    '## 1. 觸發原因與證據摘要',
    '',
    `- 觸發原因：${inline(record.trigger.reason)}（訊號 ${inline(record.trigger.signalKind)}，事件紀錄 ${inline(record.trigger.signalEventId)}）`,
    `- 證據摘要：${inline(record.trigger.evidence.summary)}`,
    `- 證據參照：${record.trigger.evidence.references.map(inline).join('、')}`,
    `- 計數：${counts.length === 0 ? '無' : counts.map(inline).join('、')}`,
    '',
    '## 2. 建議動作與理由',
    '',
    `- 建議動作：${inline(record.recommendation.title)}（${inline(record.recommendation.actionCode)} ${inline(record.recommendation.actionName)}）`,
    `- 對象：${inline(record.target.targetId)}（種類 ${inline(record.target.kind)}，資產 ${inline(record.target.assetId)}）`,
    `- 理由：${inline(record.recommendation.rationale)}`,
    `- 政策判定：${inline(record.policy.effect)}，原因 ${inline(record.policy.reason)}`,
    '',
    '## 3. 影響範圍',
    '',
    '會中斷或受影響的功能：',
    ...bulletList(record.impact.affectedFunctions, '未列出'),
    '',
    '受影響的使用者群組：',
    ...bulletList(record.impact.affectedUserGroups, '未列出（執行前請補上）'),
    '',
    `- 預估中斷時間：${downtime.min}–${downtime.max} 分鐘（${downtime.source === 'OPERATOR_PROVIDED' ? '操作者提供' : '範本預設估計，未經量測'}）`,
    ...(record.impact.notes === null ? [] : [`- 補充：${inline(record.impact.notes)}`]),
    '',
    '## 4. 執行步驟',
    '',
    '| 步驟 | 要做的事 | 確認方式 | 回復方式 |',
    '| --- | --- | --- | --- |',
    ...record.steps.map((step) =>
      `| ${step.index} | ${inline(step.instruction)} | ${inline(step.verify)} | ${inline(step.rollback)} |`),
    '',
    '## 5. 需要的資訊或權限',
    '',
    ...bulletList(record.requirements.accessNeeded, '未列出'),
    `- 管理帳號（角色）：${record.requirements.adminAccountRole === null ? '未指定（執行前請指定）' : inline(record.requirements.adminAccountRole)}`,
    `- 維護時段：${window === null ? '尚未排定（執行前必須排定）' : `${inline(window.start)} 至 ${inline(window.end)}`}`,
    ...(record.requirements.notes === null ? [] : [`- 補充：${inline(record.requirements.notes)}`]),
    '',
    `## 6. 已自動執行的 A 級動作（${inline(record.automaticActions.capturedAt)} 快照）`,
    '',
    `- 狀態來源：${AUTOMATIC_SOURCE_LABELS[record.automaticActions.source] ?? inline(record.automaticActions.source)}；最新狀態以事件摘要頁為準。`,
    ''
  ];
  if (record.automaticActions.items.length === 0) {
    lines.push('- 本事件沒有已執行或已嘗試的 A 級動作。');
  } else {
    lines.push('| 動作 | 對象 | 狀態 | 讀回 |', '| --- | --- | --- | --- |');
    for (const item of record.automaticActions.items) {
      lines.push(`| ${inline(item.actionCode)} ${inline(item.actionName)} | ${inline(item.targetId)} | ${AUTOMATIC_STATUS_LABELS[item.status] ?? inline(item.status)} | ${VERIFICATION_LABELS[item.readback] ?? inline(item.readback)} |`);
    }
  }
  lines.push('', '## 7. 執行回報與系統讀回', '');
  if (record.humanReport === null) {
    lines.push('- 尚未回報。');
  } else {
    const report = record.humanReport;
    lines.push(
      `- 回報結果：${STATUS_LABELS[report.result]}；回報人 ${inline(report.reportedBy)}（${report.actorVerified ? '已驗證身分' : '身分未驗證'}）；時間 ${inline(report.reportedAt)}`,
      ...(report.note === null ? [] : [`- 說明：${inline(report.note)}`]),
      ...report.stepResults.map((step) =>
        `- 第 ${step.index} 步：${STEP_RESULT_LABELS[step.status]}${step.note === null ? '' : `，${inline(step.note)}`}`)
    );
  }
  const verification = record.verification;
  lines.push(
    `- 系統讀回：${VERIFICATION_LABELS[verification.status]}${verification.reason === null ? '' : `（${inline(verification.reason)}）`}${verification.exhausted ? '；讀回次數已用完，請人工確認' : ''}`,
    ...verification.checks.map((check) =>
      `- 讀回檢查 ${inline(check.name)}：${CHECK_RESULT_LABELS[check.status] ?? inline(check.status)}${check.note === null ? '' : `，${inline(check.note)}`}`),
    '',
    '## 8. 政策決策摘要',
    '',
    `- 政策版本：${inline(record.policy.policyVersion)}`,
    `- 目錄摘要：${inline(record.policy.catalogDigest)}`,
    `- 登錄表摘要：${inline(record.policy.registryDigest)}`,
    `- 輸入摘要：${inline(record.policy.inputDigest)}`,
    `- 決策摘要：${inline(record.policy.decisionDigest)}`,
    `- 義務：${record.policy.obligations.map(inline).join('、')}`,
    ...(record.contentFilter.redactions.length === 0
      ? []
      : ['', `> 內容過濾：已遮蔽 ${record.contentFilter.redactions.reduce((sum, item) => sum + item.count, 0)} 處疑似憑證、ticket 原值或個資。`]),
    ''
  );
  return lines.join('\n');
}
