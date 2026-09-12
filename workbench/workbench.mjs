import { canonicalJson, sha256Hex } from '/canonical.mjs';

const byId = id => document.getElementById(id);
let state = null;
let preview = null;
let memberPreview = null;
let members = [];
let busy = false;
let messageTimer;
const ERRORS = {
  MEMBER_EXISTS: '這個帳號已存在，請重新讀取名單，不要重送新增。', MEMBER_STALE: '成員狀態已變更，請重新讀取後再預覽。',
  MEMBER_STATE: '目前狀態不支援這項操作。待設定帳號可重發設定碼或停用；角色未改變則不需套用。',
  MEMBER_UNAVAILABLE: '不能修改這個成員。Owner、已停用或其他租戶帳號不在範圍內。',
  MEMBER_CAPACITY: '已達本機測試帳號上限。', IDENTIFIER_INVALID: '帳號需小寫英文字母開頭，只能包含小寫字母、數字、底線與短橫線。',
  PERMISSION_DENIED: '目前角色沒有這項權限。伺服器已拒絕操作。',
  LOGOUT_REQUIRED: '請先登出，再使用離線恢復碼。', RECOVERY_FAILED: '無法恢復，請確認租戶、帳號與尚未使用的恢復碼。',
  PASSWORD_POLICY: '新密碼需 15–128 字元，不能使用已封鎖的常見密碼。', PASSWORD_INVALID: '密碼格式或長度不符合要求。',
  AUTH_FAILED: '帳號、密碼或驗證碼不正確。已用過的驗證碼須等下一組。', AUTH_REQUIRED: '登入已失效，請重新登入。',
  TOTP_ENROLLMENT_INVALID: '設定已過期或不是目前登入發起，請重新設定。', TOTP_KEY_REQUIRED: '本環境未配置驗證器保管金鑰；沒有降級已啟用的驗證器。',
  AUTH_RATE_LIMIT: '嘗試次數較多，請稍後再試。', AUTH_CAPACITY: '驗證忙碌中，請稍後重試。',
  INTENT_INVALID: '這份確認已失效。請重新預覽並輸入密碼。', CSRF_INVALID: '頁面驗證已失效，請重新整理。',
  SCOPE_INVALID: '請選擇有效的合成資產。', SCHEMA_INVALID: '設定格式不正確，請檢查輸入。',
  SERVICE_UNAVAILABLE: '服務暫時不可用，沒有將未知結果標示為成功。', GRANT_EXPIRY: '授權時間已過，請重新預覽。'
};
function message(text, error = false) {
  const box = byId('message'); byId('message-text').textContent = text; box.className = error ? 'error' : ''; box.hidden = false;
  box.setAttribute('role', error ? 'alert' : 'status');
  clearTimeout(messageTimer);
  if (!error) messageTimer = setTimeout(() => { box.hidden = true; }, 6000);
}
byId('dismiss-message').addEventListener('click', () => { byId('message').hidden = true; clearTimeout(messageTimer); });
async function request(path, body) {
  const options = { credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    const context = await request('/api/context');
    options.method = 'POST'; options.headers = { 'Content-Type': 'application/json', 'X-DQ-CSRF': context.csrfToken };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error ?? 'SERVICE_UNAVAILABLE'); error.code = result.error; throw error; }
  return result;
}
async function action(operation) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await operation(); }
  catch (error) {
    message(ERRORS[error.code] ?? '尚未確認結果。請先重新讀取紀錄，避免重複發布。', true);
    if (error.code === 'AUTH_REQUIRED') { state = null; preview = null; showViews(); }
  } finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); }
}
function showViews() {
  byId('login-view').hidden = !!state; byId('workspace').hidden = !state;
  byId('members-panel').hidden = !state?.capabilities?.includes('MANAGE_MEMBERS');
  byId('security-services').hidden = !state;
  if (!state) clearTotp();
  if (!state) { members = []; memberPreview = null; byId('member-list').replaceChildren(); byId('member-confirmation').hidden = true; clearSetup(); }
  if (!state) { preview = null; byId('confirmation').hidden = true; }
}
const ROLE_LABELS = { TENANT_SUPER_ADMIN: '租戶管理者', MIS_OPERATOR: 'MIS 操作者', REVIEWER: '檢閱者', AUDITOR: '稽核者' };
const allowed = action => state?.capabilities?.includes(action) === true;
function clearCodes() { byId('recovery-codes').replaceChildren(); byId('recovery-result-description').textContent = ''; byId('recovery-result').close(); }
function showCodes(result, description) {
  clearCodes();
  for (const value of result.recoveryCodes) { const li = document.createElement('li'); const code = document.createElement('code'); code.textContent = value; li.append(code); byId('recovery-codes').append(li); }
  byId('recovery-result-description').textContent = description; byId('recovery-result').showModal(); byId('dismiss-codes').focus();
}
byId('dismiss-codes').addEventListener('click', clearCodes);
byId('recovery-result').addEventListener('cancel', event => { event.preventDefault(); clearCodes(); });
function clearSetup() { byId('setup-code').textContent = ''; byId('setup-description').textContent = ''; byId('setup-result').close(); }
byId('dismiss-setup').addEventListener('click', clearSetup);
byId('setup-result').addEventListener('cancel', event => { event.preventDefault(); clearSetup(); });
window.addEventListener('pagehide', clearSetup);
window.addEventListener('pagehide', () => { clearCodes(); document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); });
const labelState = value => ({ ACTIVE: '授權有效', REVOKED: '已撤銷', EXPIRED: '已到期' }[value] ?? value);
function render() {
  showViews(); if (!state) return;
  byId('tenant-label').textContent = `${state.tenantId} / ${ROLE_LABELS[state.role] ?? '未支援角色'} / ${state.authentication === 'PASSWORD_TOTP' ? '密碼＋TOTP' : '密碼驗證'}`;
  const activeFactor = state.authentication === 'PASSWORD_TOTP';
  byId('factor-state').textContent = activeFactor ? '目前：密碼＋TOTP 已啟用。' : state.totpAvailable ? '目前：密碼模式，TOTP 尚未啟用。' : '目前：密碼模式，本環境未配置 TOTP。';
  byId('totp-enroll-form').hidden = activeFactor || !state.totpAvailable;
  byId('totp-remove-form').hidden = !activeFactor;
  document.querySelectorAll('label.optional-otp').forEach(label => { if (!label.closest('#login-form')) label.hidden = !activeFactor; });
  document.querySelector('.policy-panel').hidden = !allowed('PREVIEW_GRANT');
  document.querySelector('.revoke-panel').hidden = !allowed('REVOKE_GRANTS');
  byId('approve-form').hidden = !allowed('PUBLISH_GRANT');
  document.querySelector('.account-panel').hidden = !allowed('RENEW_RECOVERY');
  const choices = byId('asset-choices'); choices.replaceChildren();
  for (const asset of state.assets) {
    const label = document.createElement('label'); label.className = 'asset-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'assetId'; input.value = asset.id;
    input.checked = true;
    const name = document.createElement('span'); name.textContent = asset.id;
    const status = document.createElement('small'); status.textContent = asset.state === 'ACTIVE' ? '合成待命' : '合成已隔離';
    label.append(input, name, status); choices.append(label);
  }
  const grants = byId('grant-list'); grants.replaceChildren();
  if (!state.grants.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = allowed('PUBLISH_GRANT') ? '尚未發布授權。先選擇範圍、查看影響，再確認。' : '尚未發布授權。目前角色不能發布或撤銷；請由租戶管理者處理。'; grants.append(p); }
  for (const grant of state.grants) {
    const item = document.createElement('article'); item.className = 'grant';
    const title = document.createElement('div'); title.className = 'grant-title';
    const name = document.createElement('strong'); name.textContent = grant.assetIds.join('、');
    const badge = document.createElement('span'); badge.className = `badge ${grant.state === 'ACTIVE' ? '' : 'inactive'}`; badge.textContent = labelState(grant.state);
    title.append(name, badge);
    const detail = document.createElement('p'); detail.textContent = `已領取 ${grant.used} / ${grant.maxEffects} 次 · 有效至 ${new Date(grant.expiresAt).toLocaleString('zh-TW')}`;
    const ref = document.createElement('p'); ref.className = 'fine'; ref.textContent = `紀錄 ${grant.id}`;
    item.append(title, detail, ref); grants.append(item);
  }
}
async function refresh() {
  const context = await request('/api/context'); state = context.authenticated ? context.state : null;
  preview = null; memberPreview = null; byId('member-confirmation').hidden = true; byId('confirmation').hidden = true; render();
  if (allowed('MANAGE_MEMBERS')) {
    members = await request('/api/members'); const list = byId('member-list'); list.replaceChildren();
    const states = { ACTIVE: '可登入', DISABLED: '已停用', SETUP_PENDING: '待本人設定', SETUP_EXPIRED: '設定碼已過期' };
    for (const member of members) {
      const row = document.createElement('article'); row.className = 'member-row';
      const name = document.createElement('strong'); name.textContent = member.username;
      const info = document.createElement('span'); info.textContent = `${ROLE_LABELS[member.role]} · ${states[member.state]} · 版本 ${member.epoch}`;
      row.append(name, info);
      if (member.role !== 'TENANT_SUPER_ADMIN' && member.state !== 'DISABLED') {
        const select = document.createElement('button'); select.type = 'button'; select.className = 'quiet'; select.textContent = '選取';
        select.setAttribute('aria-label', `選取成員 ${member.username}`);
        select.addEventListener('click', () => { const form = byId('member-form'); form.elements.username.value = member.username;
          form.elements.action.value = member.state === 'ACTIVE' ? 'CHANGE_ROLE' : 'REISSUE_SETUP'; form.elements.role.value = member.role;
          updateMemberForm(); form.elements.action.focus(); }); row.append(select);
      }
      list.append(row);
    }
  }
  if (state) {
    byId('notification-panel').hidden = !allowed('MANAGE_MEMBERS'); byId('notification-list').replaceChildren();
    if (allowed('MANAGE_MEMBERS')) {
      const notices = await request('/api/notifications');
      const labels = { PENDING: '待送', SENDING: '派送中', UNKNOWN: '結果未知，須對帳', RETRY: '等待重試', FAILED: '重試上限，未送達', DELIVERED: '本機測試收件已確認（不是 Email）' };
      for (const notice of notices.slice(0, 10)) { const li = document.createElement('li'); li.textContent = `事件 ${notice.id}：${labels[notice.status]}，嘗試 ${notice.attempts} 次`; byId('notification-list').append(li); }
      if (!notices.length) { const li = document.createElement('li'); li.textContent = '尚無待送安全事件。'; byId('notification-list').append(li); }
    }
    const evidence = await request('/api/evidence'); byId('event-list').replaceChildren();
    const names = { LOGIN_SUCCEEDED: '管理者登入', LOGOUT: '管理者登出', INTENT_ISSUED: '密碼重新驗證',
      RECOVERY_CODES_REPLACED: '本人恢復碼已更新（通知未配置）', ACCOUNT_RECOVERED: '帳號已恢復（通知未配置）',
      ACCOUNT_RECOVERED_GRANTS_REVOKED: '管理者已恢復，租戶授權已撤銷（通知未配置）', RECOVERY_REJECTED: '恢復嘗試被拒絕',
      GRANT_PUBLISHED: '授權已發布', GRANTS_REVOKED: '租戶授權已撤銷', LOCAL_BOOTSTRAP: '本機測試環境建立',
      EFFECT_CLAIMED: '合成工作已領取', EFFECT_VERIFIED: '合成效果已讀回驗證' };
    for (const event of evidence.events.slice(-30)) { const li = document.createElement('li'); li.textContent = `${new Date(event.body.now).toLocaleTimeString('zh-TW')} · ${names[event.body.kind] ?? event.body.kind}`; byId('event-list').append(li); }
  }
}
byId('login-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    const body = Object.fromEntries(new FormData(form));
    if (!body.otp) delete body.otp;
    try { clearCodes(); await request('/api/login', body); await refresh(); message(`登入成功：${ROLE_LABELS[state.role]}。操作依角色權限開放。`); }
    finally { form.elements.password.value = ''; }
  });
});
byId('logout').addEventListener('click', () => action(async () => {
  clearSetup();
  clearCodes();
  await request('/api/logout', {}); document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
  await refresh(); message('已登出。事前授權不因登出自動撤銷。');
}));
byId('refresh').addEventListener('click', () => action(refresh));
byId('preview-form').addEventListener('input', () => { preview = null; byId('confirmation').hidden = true; });
byId('preview-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    const fields = new FormData(form); const assetIds = fields.getAll('assetId').sort();
    const context = await request('/api/context'); if (!context.authenticated) { const error = new Error(); error.code = 'AUTH_REQUIRED'; throw error; }
    const tenantId = context.state.tenantId;
    const draft = { schemaVersion: 'dungeonq.lab-grant-draft/v1', tenantId, profile: 'SYNTHETIC_ONLY', assetIds,
      effect: 'SYNTHETIC_CONTAINMENT', connectorVersion: 'sqlite-fixture/v1', runbookVersion: 'containment/v1',
      dependencyDigest: await sha256Hex(canonicalJson({ tenantId, assetIds, connectorVersion: 'sqlite-fixture/v1' })),
      expiresAt: context.state.serverNow + Number(fields.get('hours')) * 3_600_000,
      maxEffects: Number(fields.get('maxEffects')), maxConcurrent: 1, leaseMs: 300_000 };
    preview = await request('/api/grants/preview', draft);
    byId('impact').textContent = `僅允許隔離 ${preview.draft.assetIds.join('、')}，最多 ${preview.draft.maxEffects} 次，有效至 ${new Date(preview.draft.expiresAt).toLocaleString('zh-TW')}。不會輪換真實金鑰。`;
    byId('preview-digest').textContent = preview.digest; byId('confirmation').hidden = false; byId('confirm-title').focus();
    if (!allowed('PUBLISH_GRANT')) byId('impact').textContent += ' 此角色只可檢視，不能核准或發布。';
  });
});
byId('approve-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    if (!preview) throw new Error('NO_PREVIEW');
    const approved = preview;
    try {
      const intent = await reauth(form, 'PUBLISH_GRANT', approved.digest);
      await request('/api/grants/publish', { draft: approved.draft, intentToken: intent.intentToken });
      await refresh(); message('授權已發布並讀回。這是合成授權，尚無正式防護效果。');
    } finally { form.elements.password.value = ''; preview = null; byId('confirmation').hidden = true; }
  });
});
byId('revoke-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    try {
      const manifestDigest = await sha256Hex(canonicalJson({ tenantId: state.tenantId, action: 'REVOKE_GRANTS' }));
      const intent = await reauth(form, 'REVOKE_GRANTS', manifestDigest);
      await request('/api/grants/revoke', { intentToken: intent.intentToken }); await refresh(); message('本租戶既有授權已全部撤銷。');
    } finally { form.elements.password.value = ''; }
  });
});
byId('renew-recovery-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    try {
      const manifestDigest = await sha256Hex(canonicalJson({ tenantId: state.tenantId, principalId: state.principalId, action: 'RENEW_RECOVERY' }));
      const intent = await reauth(form, 'RENEW_RECOVERY', manifestDigest);
      const result = await request('/api/recovery/renew', { intentToken: intent.intentToken });
      // 先顯示單次秘密；後續讀回失敗不能把已收到的碼丟掉。
      showCodes(result, '全部舊恢復碼已作廢；現有登入及授權保持不變。');
    } finally { form.elements.password.value = ''; }
  });
});
byId('recovery-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    try {
      const body = Object.fromEntries(new FormData(form));
      if (body.newPassword !== body.confirmPassword) { message('兩次新密碼不一致，尚未送出。', true); return; }
      delete body.confirmPassword;
      const result = await request('/api/recover', body);
      state = null; preview = null; showViews();
      showCodes(result, result.grantsRevoked ? '密碼已重設，全部舊登入與租戶授權已撤銷。在途合成工作已封鎖；請用新密碼重新登入。' : '密碼已重設，自己的舊登入已撤銷；未更改租戶防護授權。請用新密碼重新登入。');
      if (result.factorRemoved) byId('recovery-result-description').textContent += ' 已依離線恢復流程解除原 TOTP，請登入後重新設定。';
    } finally { form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); }
  });
});
function updateMemberForm() {
  memberPreview = null; byId('member-confirmation').hidden = true;
  const form = byId('member-form'); form.elements.role.disabled = ['DISABLE', 'REISSUE_SETUP'].includes(form.elements.action.value);
}
byId('member-form').addEventListener('input', updateMemberForm);
byId('member-form').addEventListener('change', updateMemberForm);
byId('member-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    const fields = new FormData(form); const changeAction = fields.get('action'); const username = fields.get('username');
    const target = members.find(member => member.username === username);
    if (changeAction !== 'CREATE' && !target) { message('請先從名單選取同租戶成員。', true); return; }
    const draft = { schemaVersion: 'dungeonq.lab-member-change/v1', tenantId: state.tenantId, username,
      action: changeAction, role: ['DISABLE', 'REISSUE_SETUP'].includes(changeAction) ? target.role : fields.get('role'),
      expectedEpoch: changeAction === 'CREATE' ? 0 : target.epoch };
    memberPreview = await request('/api/members/preview', draft);
    const effects = { CREATE: '建立待設定帳號；產生 24 小時一次性設定碼，由本人設定密碼。',
      CHANGE_ROLE: '改變角色；撤銷此成員全部舊登入、意圖及恢復碼。原密碼仍可重新登入。',
      DISABLE: '停用此帳號，撤銷全部舊登入、意圖、設定碼及恢復碼；不能恢復登入。',
      REISSUE_SETUP: '作廢舊設定碼，重新產生 24 小時一次性設定碼。' };
    byId('member-impact').textContent = `${draft.tenantId} / ${username}：${memberPreview.before ? ROLE_LABELS[memberPreview.before.role] + ' → ' : ''}${ROLE_LABELS[draft.role]}。${effects[changeAction]}不修改租戶 Grant；不寄送 Email。`;
    byId('member-digest').textContent = memberPreview.digest; byId('member-confirmation').hidden = false; byId('member-confirm-title').focus();
  });
});
byId('member-apply-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    if (!memberPreview) { message('請先重新預覽成員變更。', true); return; }
    const approved = memberPreview;
    try {
      const intent = await reauth(form, 'MANAGE_MEMBERS', approved.digest);
      const result = await request('/api/members/apply', { draft: approved.draft, intentToken: intent.intentToken });
      if (result.setupCode) {
        clearSetup(); byId('setup-code').textContent = result.setupCode;
        byId('setup-description').textContent = `${state.tenantId} / ${result.username} · ${ROLE_LABELS[result.role]} · 有效至 ${new Date(result.setupExpiresAt).toLocaleString('zh-TW')}`;
        byId('setup-result').showModal();
      }
      await refresh(); message('成員變更已套用並讀回名單。');
    } finally { form.elements.password.value = ''; memberPreview = null; byId('member-confirmation').hidden = true; }
  });
});
function clearTotp() { byId('totp-seed').textContent = ''; byId('totp-expiry').textContent = ''; byId('totp-confirm-form').reset(); byId('totp-setup').close(); }
byId('dismiss-totp').addEventListener('click', clearTotp);
byId('totp-setup').addEventListener('cancel', event => { event.preventDefault(); clearTotp(); });
window.addEventListener('pagehide', clearTotp);
for (const formId of ['login-form', 'approve-form', 'revoke-form', 'renew-recovery-form', 'member-apply-form', 'totp-enroll-form', 'totp-remove-form']) {
  const form = byId(formId); const label = document.createElement('label'); label.className = 'optional-otp';
  label.append('TOTP 驗證碼（已啟用才填）'); const input = document.createElement('input');
  input.name = 'otp'; input.type = 'password'; input.inputMode = 'numeric'; input.pattern = '[0-9]{6}'; input.maxLength = 6; input.autocomplete = 'one-time-code';
  label.append(input); form.insertBefore(label, form.querySelector('button'));
}
function reauth(form, purpose, manifestDigest) {
  const otp = form.elements.otp.value;
  return request('/api/intents', { password: form.elements.password.value, purpose, manifestDigest, ...(otp ? { otp } : {}) });
}
async function factorIntent(form, purpose) {
  return reauth(form, purpose, await sha256Hex(canonicalJson({ tenantId: state.tenantId, principalId: state.principalId, action: purpose })));
}
byId('totp-enroll-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    const intent = await factorIntent(form, 'ENROLL_TOTP');
    const result = await request('/api/totp/begin', { intentToken: intent.intentToken });
    clearTotp(); byId('totp-seed').textContent = result.secret;
    byId('totp-expiry').textContent = `請於 ${new Date(result.expiresAt).toLocaleTimeString('zh-TW')} 前輸入驗證碼；未確認前不會啟用。`;
    byId('totp-setup').showModal(); byId('totp-confirm-form').elements.otp.focus();
  });
});
byId('totp-confirm-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    await request('/api/totp/confirm', { otp: form.elements.otp.value }); clearTotp(); await refresh();
    message('TOTP 已啟用，舊登入已撤銷。請等下一組驗證碼，重新登入。');
  });
});
byId('totp-remove-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(async () => {
    const intent = await factorIntent(form, 'REMOVE_TOTP');
    await request('/api/totp/remove', { intentToken: intent.intentToken }); await refresh(); message('已解除 TOTP，舊登入已撤銷。請用密碼重新登入。');
  });
});
window.addEventListener('pageshow', event => { if (event.persisted) action(refresh); });
action(refresh);
