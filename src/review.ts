import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import { validId } from './apple-rules.js';

export interface ReviewAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
}
export type ReviewRelation = 'appStoreVersion' | 'appAssetLibraryImage' | 'appAssetLibraryVideo' | 'inAppPurchaseVersion' | 'subscriptionVersion' | 'subscriptionGroupVersion' | 'appCustomProductPageVersion' | 'appStoreVersionExperimentV2' | 'appEvent';
const TYPES: Record<ReviewRelation, string> = { appStoreVersion: 'appStoreVersions', appAssetLibraryImage: 'appAssetLibraryImages', appAssetLibraryVideo: 'appAssetLibraryVideos',
  inAppPurchaseVersion: 'inAppPurchaseVersions', subscriptionVersion: 'subscriptionVersions', subscriptionGroupVersion: 'subscriptionGroupVersions',
  appCustomProductPageVersion: 'appCustomProductPageVersions', appStoreVersionExperimentV2: 'appStoreVersionExperiments', appEvent: 'appEvents' };
export interface ReviewItem { relation: ReviewRelation; id: string }
export interface ReviewResult { status: 'submitted' | 'resubmitted' | 'already_submitted'; submissionId: string; state: string; addedItems: string[] }
const key = (relation: string, id: string) => `${relation}:${id}`;
const IN_FLIGHT = ['WAITING_FOR_REVIEW', 'IN_REVIEW'];

async function itemKeys(api: ReviewAPI, submissionId: string): Promise<{ keys: Set<string>; unknown: number }> {
  const query = new URLSearchParams({ include: Object.keys(TYPES).join(','), limit: '200' });
  const items = await api.list(`/v1/reviewSubmissions/${submissionId}/items?${query}`, 2000);
  if (items.truncated) throw new Error('Incomplete review item list; refusing to submit.');
  const keys = new Set<string>();
  let unknown = 0;
  for (const row of items.data) {
    if (row.attributes.state === 'REMOVED') continue;
    let linked = false;
    for (const [relation, value] of Object.entries(row.relationships ?? {})) {
      if (value.data && !Array.isArray(value.data)) { keys.add(key(relation, value.data.id)); linked = true; }
    }
    if (!linked) unknown++;
  }
  return { keys, unknown };
}
async function submissions(api: ReviewAPI, appId: string, platform: string, states: string[]): Promise<Resource[]> {
  const query = new URLSearchParams({ 'filter[platform]': platform, 'filter[state]': states.join(','), limit: '50' });
  const result = await api.list(`/v1/apps/${appId}/reviewSubmissions?${query}`, 50);
  if (result.truncated) throw new Error('Incomplete review submission list; refusing to submit.');
  return result.data;
}

/**
 * Sends exactly the requested items to App Review. A draft holding anything else is refused,
 * so unrelated work someone prepared in App Store Connect is never submitted by accident.
 * Safe to rerun after an interruption: drafts are reused and in-flight submissions are detected.
 */
export async function submitForReview(input: { account: Account; appId: string; platform?: string; items: ReviewItem[] }, api: ReviewAPI): Promise<ReviewResult> {
  const { account, appId } = input;
  const items = input.items.filter((item, i, all) => all.findIndex(o => o.relation === item.relation && o.id === item.id) === i);
  const platform = input.platform ?? 'IOS';
  requireWrite(account, appId);
  if (!items.length || !items.every(i => validId(i.id))) throw new Error('Provide at least one valid item to submit.');
  if (items.length > 200) throw new Error('Apple allows at most 200 items in one review submission.');
  const wanted = items.map(i => key(i.relation, i.id));
  for (const active of await submissions(api, appId, platform, IN_FLIGHT)) {
    const { keys } = await itemKeys(api, active.id);
    if (wanted.every(k => keys.has(k))) return { status: 'already_submitted', submissionId: active.id, state: String(active.attributes.state), addedItems: [] };
  }
  // A rejected submission stays open as UNRESOLVED_ISSUES and is sent again rather than replaced.
  let rejected: Resource | undefined;
  for (const candidate of await submissions(api, appId, platform, ['UNRESOLVED_ISSUES'])) {
    const { keys: inCandidate } = await itemKeys(api, candidate.id);
    if (wanted.some(k => inCandidate.has(k))) { rejected = candidate; break; }
  }
  const existing = rejected ?? (await submissions(api, appId, platform, ['READY_FOR_REVIEW']))[0];
  const draft = existing ?? await api.post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform },
    relationships: { app: { data: { type: 'apps', id: appId } } } } });
  if (draft.type !== 'reviewSubmissions' || !draft.id) throw new Error('Invalid review submission response.');
  const { keys: held, unknown } = existing ? await itemKeys(api, draft.id) : { keys: new Set<string>(), unknown: 0 };
  const foreign = [...held].filter(k => !wanted.includes(k));
  if (foreign.length || unknown) throw new Error(`Review draft ${draft.id} already holds other items (${[...foreign, ...(unknown ? [`${unknown} unidentified`] : [])].join(', ')}). Submit or remove them in App Store Connect first.`);
  const added: string[] = [];
  for (const item of items) {
    if (held.has(key(item.relation, item.id))) continue;
    await api.post('/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: {
      reviewSubmission: { data: { type: 'reviewSubmissions', id: draft.id } },
      [item.relation]: { data: { type: TYPES[item.relation], id: item.id } } } } });
    added.push(item.id);
  }
  await api.patch(`/v1/reviewSubmissions/${draft.id}`, 'reviewSubmissions', draft.id, { submitted: true });
  const after = await api.get(`/v1/reviewSubmissions/${draft.id}`);
  return { status: rejected ? 'resubmitted' : 'submitted', submissionId: draft.id, state: String(after.attributes.state ?? 'UNKNOWN'), addedItems: added };
}
