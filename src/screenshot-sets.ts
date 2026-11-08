import { requireWrite, type Account } from './config.js';
import type { Resource, Method } from './apple.js';
import { checkPermutation, type OrderResult } from './asset-library.js';
import { verifyLocalization, verifySet } from './screenshots.js';

export interface ScreenshotSetAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
}
/** Display types follow Apple's ScreenshotDisplayType enum, e.g. APP_IPHONE_67 or IMESSAGE_APP_IPAD_PRO_129. */
export const validDisplayType = (value: string) => /^(APP|IMESSAGE_APP)_[A-Z0-9_]{2,40}$/.test(value);

/** Creates a screenshot set for one display type, or returns the existing one. Safe to rerun after a timeout. */
export async function createScreenshotSet(input: { account: Account; appId: string; versionId: string; localizationId: string; displayType: string },
  api: ScreenshotSetAPI): Promise<{ status: 'exists' | 'created'; setId: string; displayType: string }> {
  const { account, appId, versionId, localizationId, displayType } = input;
  requireWrite(account, appId);
  if (!validDisplayType(displayType)) throw new Error('Invalid screenshot display type, e.g. APP_IPHONE_67.');
  await verifyLocalization(api, appId, versionId, localizationId);
  const sets = await api.list(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=200`, 200);
  if (sets.truncated) throw new Error('Incomplete screenshot set list; refusing an uncertain duplicate.');
  const existing = sets.data.find(row => row.attributes.screenshotDisplayType === displayType);
  if (existing) return { status: 'exists', setId: existing.id, displayType };
  const created = await api.post('/v1/appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType },
    relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } } } });
  if (created.type !== 'appScreenshotSets' || !created.id) throw new Error('Invalid screenshot set response.');
  return { status: 'created', setId: created.id, displayType };
}

/** Reorders screenshots inside a legacy screenshot set by replacing the ordered relationship. */
export async function orderScreenshots(input: { account: Account; appId: string; versionId: string; localizationId: string; setId: string; screenshotIds: string[] },
  api: ScreenshotSetAPI): Promise<OrderResult> {
  const { account, appId, versionId, localizationId, setId, screenshotIds } = input;
  requireWrite(account, appId);
  await verifyLocalization(api, appId, versionId, localizationId);
  await verifySet(api, localizationId, setId);
  const read = async () => {
    const result = await api.list(`/v1/appScreenshotSets/${setId}/relationships/appScreenshots?limit=200`, 200);
    if (result.truncated) throw new Error('Incomplete screenshot list; refusing to reorder.');
    return result.data.map(row => row.id);
  };
  const current = await read();
  checkPermutation(current, screenshotIds, 'screenshot');
  if (current.join() === screenshotIds.join()) return { status: 'unchanged', order: current };
  await api.request('PATCH', `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, { data: screenshotIds.map(id => ({ type: 'appScreenshots', id })) });
  const after = await read();
  if (after.join() !== screenshotIds.join()) throw new Error(`Apple has not confirmed the requested order. Current order: ${after.join(',')}`);
  return { status: 'reordered', order: after };
}
