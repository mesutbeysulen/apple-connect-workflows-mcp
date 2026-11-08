import { accountIdentity, requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import type { AssetJob, PlanStore } from './plans.js';
import { readImage, rereadImage, sendParts, validId, verifyLocalization } from './screenshots.js';

/** Apple client surface used by Asset Library workflows (App Store Connect API 4.6+). */
export interface AssetAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  delete(path: string): Promise<void>;
}
export const IMAGE_PLACEMENT_TYPES = ['APP_SCREENSHOT', 'IMESSAGE_APP_SCREENSHOT'] as const;
export type ImagePlacementType = typeof IMAGE_PLACEMENT_TYPES[number];
/** Placement groups come from Apple (existing placements or appAssetLibraryRefData); only the shape is checked locally. */
export const validGroup = (group: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(group);
export const imageState = (resource: Resource) => String(resource.attributes.state ?? 'UNKNOWN');
const stateDetails = (resource: Resource) => {
  const details = resource.attributes.stateDetails;
  return Array.isArray(details) && details.length ? ` Details: ${JSON.stringify(details).slice(0, 500)}` : '';
};
const UPLOADED_STATES = new Set(['UPLOAD_COMPLETE', 'COMPLETE', 'PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED', 'APPROVED']);

export async function assetLibraryId(api: Pick<AssetAPI, 'get'>, appId: string): Promise<string> {
  if (!validId(appId)) throw new Error('Invalid app ID.');
  const library = await api.get(`/v1/apps/${appId}/assetLibrary`);
  if (library.type !== 'appAssetLibraries' || !library.id || !validId(library.id)) throw new Error('Apple returned no asset library for this app.');
  return library.id;
}
export interface AssetUploadInput {
  account: Account; appId: string; versionId: string; localizationId: string;
  placementGroup: string; placementType?: ImagePlacementType; filePath: string; referenceName?: string;
}
export interface AssetUploadResult { imageId: string; imageState: string; placementId: string }

/**
 * Uploads one image into the app's Asset Library and places it on a version localization.
 * The reservation is journaled before bytes move so an interrupted run can be resumed by image ID.
 */
export async function uploadAsset(input: AssetUploadInput, api: AssetAPI, fetcher: typeof fetch = fetch, store?: PlanStore): Promise<AssetUploadResult> {
  const { account, appId, versionId, localizationId, placementGroup, filePath, referenceName } = input;
  const placementType = input.placementType ?? 'APP_SCREENSHOT';
  requireWrite(account, appId);
  if (!IMAGE_PLACEMENT_TYPES.includes(placementType)) throw new Error(`Image placement type must be one of ${IMAGE_PLACEMENT_TYPES.join(', ')}.`);
  if (!validGroup(placementGroup)) throw new Error('Invalid placement group.');
  if (referenceName !== undefined && (referenceName.length < 1 || referenceName.length > 128)) throw new Error('Reference name must be 1-128 characters.');
  const { name, bytes, sha256 } = await readImage(filePath);
  await verifyLocalization(api, appId, versionId, localizationId);
  const libraryId = await assetLibraryId(api, appId);
  const reserved = await api.post('/v1/appAssetLibraryImages', { data: { type: 'appAssetLibraryImages',
    attributes: { category: 'APP_SCREENSHOTS_AND_PREVIEWS', fileName: name, fileSize: bytes.length, ...(referenceName ? { referenceName } : {}) },
    relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: libraryId } } } } });
  if (reserved.type !== 'appAssetLibraryImages' || !reserved.id || !validId(reserved.id)) throw new Error('Invalid asset image reservation response.');
  const job: AssetJob = { id: reserved.id, account: account.name, identity: accountIdentity(account), appId, versionId, localizationId,
    placementType, placementGroup, filePath, sha256, createdAt: Date.now(), placementId: null, status: 'reserved', error: null };
  store?.saveAsset(job);
  return continueAsset(job, bytes, reserved, api, fetcher, store);
}

async function continueAsset(job: AssetJob, bytes: Buffer, image: Resource, api: AssetAPI, fetcher: typeof fetch, store?: PlanStore): Promise<AssetUploadResult> {
  try {
    let state = imageState(image);
    if (state === 'AWAITING_UPLOAD') {
      await sendParts(image.attributes.uploadOperations, bytes, fetcher);
      store?.updateAsset(job.id, 'transferred');
      await api.patch(`/v1/appAssetLibraryImages/${job.id}`, 'appAssetLibraryImages', job.id, { uploaded: true });
      image = await api.get(`/v1/appAssetLibraryImages/${job.id}`);
      state = imageState(image);
    }
    if (!UPLOADED_STATES.has(state)) throw new Error(`Apple reports asset image state ${state}.${stateDetails(image)}`);
    store?.updateAsset(job.id, 'uploaded');
    const placementId = job.placementId ?? await findPlacement(job, api) ?? await createPlacement(job, api);
    store?.updateAsset(job.id, 'placed', null, placementId);
    return { imageId: job.id, imageState: state, placementId };
  } catch (error) {
    store?.updateAsset(job.id, 'needs_reconciliation', error instanceof Error ? error.message : 'Upload failed');
    throw new Error(`${error instanceof Error ? error.message : 'Upload failed'} Asset job: ${job.id}`);
  }
}
/** Finds a placement of this image already on the localization, e.g. created before a crash. */
async function findPlacement(job: AssetJob, api: AssetAPI): Promise<string | undefined> {
  const query = new URLSearchParams({ 'filter[image]': job.id, 'filter[placementGroup]': job.placementGroup, limit: '50' });
  const existing = await api.list(`/v1/appStoreVersionLocalizations/${job.localizationId}/placements?${query}`, 50);
  if (existing.truncated) throw new Error('Incomplete placement list; refusing to risk a duplicate placement.');
  return existing.data.find(p => p.attributes.placementType === undefined || p.attributes.placementType === job.placementType)?.id;
}
async function createPlacement(job: AssetJob, api: AssetAPI): Promise<string> {
  const placement = await api.post('/v1/appAssetLibraryPlacements', { data: { type: 'appAssetLibraryPlacements',
    attributes: { placementType: job.placementType, placementGroup: job.placementGroup },
    relationships: { image: { data: { type: 'appAssetLibraryImages', id: job.id } },
      appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: job.localizationId } } } } });
  if (placement.type !== 'appAssetLibraryPlacements' || !placement.id) throw new Error('Invalid placement response.');
  return placement.id;
}

/** Continues a journaled Asset Library upload without creating another reservation. */
export async function resumeAsset(id: string, account: Account, store: PlanStore, api: AssetAPI, fetcher: typeof fetch = fetch): Promise<AssetUploadResult> {
  if (!validId(id)) throw new Error('Invalid asset job ID.');
  const job = store.asset(id);
  if (job.account !== account.name || job.identity !== accountIdentity(account)) throw new Error('Asset job belongs to a different account identity.');
  requireWrite(account, job.appId);
  if (job.status === 'placed' && job.placementId) return { imageId: id, imageState: imageState(await api.get(`/v1/appAssetLibraryImages/${id}`)), placementId: job.placementId };
  const bytes = await rereadImage(job.filePath, job.sha256);
  await verifyLocalization(api, job.appId, job.versionId, job.localizationId);
  const image = await api.get(`/v1/appAssetLibraryImages/${id}`);
  const state = imageState(image);
  if (state !== 'AWAITING_UPLOAD' && !UPLOADED_STATES.has(state)) throw new Error(`Cannot resume asset image state ${state}; job ${id}. Use asset-cleanup to remove it.`);
  return continueAsset(job, bytes, image, api, fetcher, store);
}

export interface OrderResult { status: 'unchanged' | 'reordered'; order: string[] }
/** Rejects anything other than an exact permutation of the current members. */
export function checkPermutation(current: string[], requested: string[], label: string): void {
  if (!requested.length || !requested.every(validId)) throw new Error(`Provide the ${label} IDs in the desired order.`);
  if (new Set(requested).size !== requested.length) throw new Error(`Duplicate ${label} ID in requested order.`);
  const known = new Set(current);
  if (requested.length !== current.length || !requested.every(id => known.has(id))) {
    throw new Error(`Requested order must list every current ${label} exactly once. Current order: ${current.join(',')}`);
  }
}
/** Reorders Asset Library placements within one placement group of a version localization. */
export async function orderPlacements(input: { account: Account; appId: string; versionId: string; localizationId: string; placementGroup: string; placementIds: string[] },
  api: AssetAPI): Promise<OrderResult> {
  const { account, appId, versionId, localizationId, placementGroup, placementIds } = input;
  requireWrite(account, appId);
  if (!validGroup(placementGroup)) throw new Error('Invalid placement group.');
  await verifyLocalization(api, appId, versionId, localizationId);
  const read = async () => {
    const query = new URLSearchParams({ 'filter[placementGroup]': placementGroup, sort: 'placementGroupPosition', limit: '200' });
    const result = await api.list(`/v1/appStoreVersionLocalizations/${localizationId}/placements?${query}`, 200);
    if (result.truncated) throw new Error('Incomplete placement list; refusing to reorder.');
    return result.data.map(row => row.id);
  };
  const current = await read();
  checkPermutation(current, placementIds, 'placement');
  if (current.join() === placementIds.join()) return { status: 'unchanged', order: current };
  await api.post('/v1/appAssetLibraryPlacementOrderingRequests', { data: { type: 'appAssetLibraryPlacementOrderingRequests',
    attributes: { placementGroup },
    relationships: { orderedPlacements: { data: placementIds.map(id => ({ type: 'appAssetLibraryPlacements', id })) },
      appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } } } });
  const after = await read();
  if (after.join() !== placementIds.join()) throw new Error(`Apple has not confirmed the requested order. Current order: ${after.join(',')}`);
  return { status: 'reordered', order: after };
}
