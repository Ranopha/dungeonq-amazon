// 固定人工研究資料；只有可信實驗啟動器可啟用，不是正式來源。
import { readFileSync } from 'node:fs';
import { insist } from './transport.mjs';
export const STUDY_FIXTURE = 'wrong-ticket-v1';
export function studyRecords(diverted = false) {
  const artifact = { application: 'LedgerDesk', release: '2026.10.21', environment: 'primary', region: 'ap-east',
    schema: 'delivery/v3', owner: 'platform', issuedAt: '2026-10-21T00:00:00Z', expiresAt: '2026-10-22T00:00:00Z',
    purpose: 'release-verification', deliveryCode: diverted ? 'release-7c42-blue' : 'release-9e18-green' };
  return [
    { key: 'welcome', value: { application: 'LedgerDesk', current: 'deployment-manifest', previous: 'release-history' } },
    { key: 'deployment-manifest', value: artifact },
    { key: 'release-history', value: { release: '2026.10.20', status: 'superseded', current: 'deployment-manifest' } }
  ];
}
export function studyBlueprint(name) {
  insist(name === STUDY_FIXTURE, 'STUDY_FIXTURE_INVALID');
  const blueprint = JSON.parse(readFileSync(new URL('./blueprints/participant.json', import.meta.url), 'utf8'));
  return { ...blueprint, id: 'wrong-ticket-study-v1', records: studyRecords(true) };
}
