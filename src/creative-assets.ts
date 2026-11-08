import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { accountIdentity, requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import type { CreativeJob, PlanStore } from './plans.js';
import { assetLibraryId, imageState, validGroup, type AssetAPI } from './asset-library.js';
import { EDITABLE_VERSION_STATES, validId, validateOperations } from './screenshots.js';
import { submitForReview, type ReviewAPI, type ReviewItem, type ReviewResult } from './review.js';

/** Header and Search Results placements (iOS 27 / iPadOS 27 product page creative assets). */
export const CREATIVE_PLACEMENTS = { header: 'PRODUCT_PAGE_HEADER_ASSET', search: 'APP_STORE_SEARCH_RESULTS_ASSET' } as const;
export type CreativeTarget = keyof typeof CREATIVE_PLACEMENTS;
export type CreativeKind = 'image' | 'video';
const RESOURCE = { image: 'appAssetLibraryImages', video: 'appAssetLibraryVideos' } as const;
const COLLECTION = { image: 'images', video: 'videos' } as const;
const RELATION = { image: 'image', video: 'video' } as const;
const NEVER_PLACEABLE = new Set(['AWAITING_UPLOAD', 'FAILED', 'REJECTED', 'ARCHIVED']);
const SUBMITTABLE = new Set(['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW']);

export function parseTargets(value: string): CreativeTarget[] {
  const targets = [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  if (!targets.length || !targets.every(t => t in CREATIVE_PLACEMENTS)) throw new Error('Placements must be header, search or header,search.');
  return targets as CreativeTarget[];
}
export interface ImageInfo { width: number; height: number; hasAlpha: boolean }
/** Reads pixel size and alpha from PNG/JPEG headers so bad files fail before a reservation exists. */
export function imageInfo(bytes: Buffer): ImageInfo {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 26) {
    const colorType = bytes[25]!;
    // tRNS may only appear before image data, so walking chunks avoids false hits inside compressed pixels.
    let transparency = false;
    for (let at = 8; at + 8 <= bytes.length;) {
      const chunk = bytes.toString('latin1', at + 4, at + 8);
      if (chunk === 'IDAT') break;
      if (chunk === 'tRNS') { transparency = true; break; }
      at += 12 + bytes.readUInt32BE(at);
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), hasAlpha: colorType === 4 || colorType === 6 || transparency };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5), hasAlpha: false };
      if (marker === 0xff) { at++; continue; }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  throw new Error('Could not read image dimensions; use a valid PNG or JPEG.');
}
interface Spec { specId?: string; dimensions?: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number }; compatiblePlacementTypes?: string[]; alphaAllowed?: boolean; fileExtensions?: string[]; maxFileSize?: number }
/** Current specs come from Apple's reference data so size rules are never hard-coded here. */
async function specsFor(api: Pick<AssetAPI, 'list'>, kind: CreativeKind, targets: CreativeTarget[]): Promise<Map<CreativeTarget, Spec[]>> {
  const query = new URLSearchParams({ 'filter[placementTypes]': targets.map(t => CREATIVE_PLACEMENTS[t]).join(',') });
  const rows = await api.list(`/v1/appAssetLibraryRefData?${query}`, 2000);
  const specs = rows.data.flatMap(row => (row.attributes[kind === 'image' ? 'imageSpecs' : 'videoSpecs'] as Spec[] | undefined) ?? []);
  return new Map(targets.map(t => [t, specs.filter(s => s.compatiblePlacementTypes?.includes(CREATIVE_PLACEMENTS[t]))]));
}
const extensionOk = (spec: Spec, name: string) => {
  const ext = extname(name).slice(1).toLowerCase();
  return !spec.fileExtensions?.length || spec.fileExtensions.some(e => e.replace(/^\./, '').toLowerCase() === ext);
};
function matches(spec: Spec, info: ImageInfo, size: number, name: string): boolean {
  const d = spec.dimensions ?? {};
  return info.width >= (d.minWidth ?? 0) && info.width <= (d.maxWidth ?? Infinity) && info.height >= (d.minHeight ?? 0) && info.height <= (d.maxHeight ?? Infinity)
    && (spec.alphaAllowed !== false || !info.hasAlpha) && size <= (spec.maxFileSize ?? Infinity) && extensionOk(spec, name);
}
const describe = (specs: Spec[]) => specs.map(s => {
  const d = s.dimensions ?? {};
  return `${s.specId ?? 'spec'} ${d.minWidth}-${d.maxWidth}x${d.minHeight}-${d.maxHeight}${s.alphaAllowed === false ? ' no alpha' : ''}`;
}).join('; ');

async function inspect(filePath: string): Promise<{ kind: CreativeKind; name: string; size: number; sha256: string; head: Buffer }> {
  if (!isAbsolute(filePath)) throw new Error('Use an absolute file path.');
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1) throw new Error('Creative asset file is missing or empty.');
  const name = basename(filePath);
  const kind: CreativeKind | undefined = /\.(png|jpe?g)$/i.test(name) ? 'image' : /\.(mov|mp4|m4v)$/i.test(name) ? 'video' : undefined;
  if (!kind) throw new Error('Creative asset must be PNG, JPEG, MOV, MP4 or M4V.');
  const handle = await open(filePath, 'r');
  const head = Buffer.alloc(Math.min(info.size, 2 * 1024 * 1024));
  try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
  if (kind === 'video' && head.subarray(4, 8).toString('latin1') !== 'ftyp') throw new Error('Video file has no ftyp header.');
  if (kind === 'image') {
    const png = head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (/\.png$/i.test(name) ? !png : !(head[0] === 0xff && head[1] === 0xd8)) throw new Error('File extension and image signature do not match.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { kind, name, size: info.size, sha256: hash.digest('hex'), head };
}
export interface CreativeUploadResult { assetId: string; kind: CreativeKind; state: string; specCheck: 'passed' | 'apple_validates'; next: string }

/**
 * Uploads a creative asset to the app's Asset Library. It is not placed or submitted here:
 * Apple allows review before any placement, and live versions accept only approved assets.
 */
export async function uploadCreative(input: { account: Account; appId: string; targets: CreativeTarget[]; filePath: string; referenceName?: string; previewFrameTimeCode?: string },
  api: AssetAPI, fetcher: typeof fetch = fetch, store?: PlanStore): Promise<CreativeUploadResult> {
  const { account, appId, targets, filePath, referenceName, previewFrameTimeCode } = input;
  requireWrite(account, appId);
  if (!targets.length) throw new Error('Choose at least one of header, search.');
  if (referenceName !== undefined && (referenceName.length < 1 || referenceName.length > 128)) throw new Error('Reference name must be 1-128 characters.');
  const file = await inspect(filePath);
  if (previewFrameTimeCode !== undefined && file.kind !== 'video') throw new Error('--preview-frame applies only to videos.');
  const specs = await specsFor(api, file.kind, targets);
  let specCheck: CreativeUploadResult['specCheck'] = 'apple_validates';
  if (file.kind === 'image') {
    const info = imageInfo(file.head);
    for (const target of targets) {
      const list = specs.get(target)!;
      if (list.length && !list.some(s => matches(s, info, file.size, file.name))) throw new Error(`${info.width}x${info.height}${info.hasAlpha ? ' with alpha' : ''} does not fit ${target}. Apple specs: ${describe(list)}`);
    }
    if (targets.every(t => specs.get(t)!.length)) specCheck = 'passed';
  } else {
    for (const target of targets) {
      const list = specs.get(target)!;
      if (list.length && !list.some(s => file.size <= (s.maxFileSize ?? Infinity) && extensionOk(s, file.name))) throw new Error(`Video type or size does not fit ${target}. Apple specs: ${describe(list)}`);
    }
  }
  const libraryId = await assetLibraryId(api, appId);
  const reserved = await api.post(`/v1/${RESOURCE[file.kind]}`, { data: { type: RESOURCE[file.kind],
    attributes: { category: 'CREATIVE_ASSETS', fileName: file.name, fileSize: file.size, ...(referenceName ? { referenceName } : {}), ...(previewFrameTimeCode ? { previewFrameTimeCode } : {}) },
    relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: libraryId } } } } });
  if (reserved.type !== RESOURCE[file.kind] || !reserved.id || !validId(reserved.id)) throw new Error('Invalid creative asset reservation response.');
  const job: CreativeJob = { id: reserved.id, kind: file.kind, account: account.name, identity: accountIdentity(account), appId, filePath, sha256: file.sha256, size: file.size, createdAt: Date.now(), status: 'reserved', error: null };
  store?.saveCreative(job);
  const result = await transfer(job, reserved, api, fetcher, store);
  return { ...result, specCheck };
}
async function transfer(job: CreativeJob, asset: Resource, api: AssetAPI, fetcher: typeof fetch, store?: PlanStore): Promise<Omit<CreativeUploadResult, 'specCheck'>> {
  const resource = RESOURCE[job.kind];
  try {
    let current = asset;
    if (imageState(current) === 'AWAITING_UPLOAD') {
      for (const op of validateOperations(current.attributes.uploadOperations, job.size)) {
        const response = await fetcher(op.url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10 * 60_000),
          headers: Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value])),
          body: createReadStream(job.filePath, { start: op.offset, end: op.offset + op.length - 1 }), duplex: 'half' } as unknown as RequestInit);
        if (!response.ok) throw new Error(`Creative asset transfer failed: HTTP ${response.status}.`);
        await response.body?.cancel();
      }
      if ((await stat(job.filePath)).size !== job.size) throw new Error('Source file changed during upload.');
      store?.updateCreative(job.id, 'transferred');
      await api.patch(`/v1/${resource}/${job.id}`, resource, job.id, { uploaded: true });
      current = await api.get(`/v1/${resource}/${job.id}`);
    }
    const state = imageState(current);
    if (state === 'FAILED') throw new Error(`Apple rejected the creative asset. ${JSON.stringify(current.attributes.stateDetails ?? []).slice(0, 500)}`);
    store?.updateCreative(job.id, state);
    return { assetId: job.id, kind: job.kind, state, next: 'Poll creative_status until PREPARE_FOR_SUBMISSION, then creative-submit, then creative-place.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    store?.updateCreative(job.id, 'needs_reconciliation', message);
    throw new Error(`${message} Creative job: ${job.id}`);
  }
}
export async function resumeCreative(id: string, account: Account, store: PlanStore, api: AssetAPI, fetcher: typeof fetch = fetch): Promise<Omit<CreativeUploadResult, 'specCheck'>> {
  if (!validId(id)) throw new Error('Invalid creative job ID.');
  const job = store.creative(id);
  if (job.account !== account.name || job.identity !== accountIdentity(account)) throw new Error('Creative job belongs to a different account identity.');
  requireWrite(account, job.appId);
  const file = await inspect(job.filePath);
  if (file.sha256 !== job.sha256) throw new Error('Source file changed; cannot resume upload.');
  return transfer(job, await api.get(`/v1/${RESOURCE[job.kind]}/${id}`), api, fetcher, store);
}
/** Loads an asset through the app's own library, which also proves it belongs to this app. */
async function libraryAsset(api: AssetAPI, appId: string, kind: CreativeKind, id: string): Promise<Resource> {
  if (!validId(id)) throw new Error(`Invalid ${kind} ID.`);
  const libraryId = await assetLibraryId(api, appId);
  const query = new URLSearchParams({ 'filter[id]': id, limit: '1' });
  const row = (await api.list(`/v1/appAssetLibraries/${libraryId}/${COLLECTION[kind]}?${query}`, 1)).data.find(r => r.id === id);
  if (!row) throw new Error(`${kind} ${id} is not in this app's Asset Library.`);
  return row;
}
/** Standalone creative review: needs no new app version and no placement. */
export async function submitCreatives(input: { account: Account; appId: string; imageIds?: string[]; videoIds?: string[] }, api: AssetAPI & ReviewAPI): Promise<ReviewResult> {
  const { account, appId, imageIds = [], videoIds = [] } = input;
  requireWrite(account, appId);
  const items: ReviewItem[] = [];
  for (const [kind, ids, relation] of [['image', imageIds, 'appAssetLibraryImage'], ['video', videoIds, 'appAssetLibraryVideo']] as const) {
    for (const id of ids) {
      const state = imageState(await libraryAsset(api, appId, kind, id));
      if (!SUBMITTABLE.has(state) && !['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(state)) throw new Error(`${kind} ${id} cannot be submitted from state ${state}.`);
      items.push({ relation, id });
    }
  }
  return submitForReview({ account, appId, items }, api);
}
export interface PlacementOutcome { target: CreativeTarget; placementId: string; status: 'exists' | 'created'; replaced: string[] }
/** Places one asset as Header and/or Search Results on a version localization. Removes nothing without replace. */
export async function placeCreative(input: { account: Account; appId: string; versionId: string; localizationId: string; kind: CreativeKind; assetId: string; targets: CreativeTarget[]; placementGroup?: string; replace?: boolean },
  api: AssetAPI): Promise<{ assetId: string; assetState: string; placements: PlacementOutcome[] }> {
  const { account, appId, versionId, localizationId, kind, assetId, targets, placementGroup, replace = false } = input;
  requireWrite(account, appId);
  if (![versionId, localizationId].every(validId)) throw new Error('Invalid version or localization ID.');
  if (!targets.length) throw new Error('Choose at least one of header, search.');
  if (placementGroup !== undefined && !validGroup(placementGroup)) throw new Error('Invalid placement group.');
  if ((await api.get(`/v1/appStoreVersions/${versionId}/app`)).id !== appId) throw new Error('Version does not belong to the requested app.');
  const version = await api.get(`/v1/appStoreVersions/${versionId}`);
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (localizations.truncated || !localizations.data.some(row => row.id === localizationId)) throw new Error('Localization is not verified for this version.');
  const assetState = imageState(await libraryAsset(api, appId, kind, assetId));
  if (NEVER_PLACEABLE.has(assetState)) throw new Error(`${kind} ${assetId} cannot be placed from state ${assetState}.`);
  // Apple refuses unapproved assets on an approved parent; say so before attempting a write.
  if (!EDITABLE_VERSION_STATES.includes(String(version.attributes.appStoreState)) && assetState !== 'APPROVED') throw new Error(`Version state ${version.attributes.appStoreState} accepts only APPROVED assets; this one is ${assetState}. Use creative-submit first.`);
  const placements: PlacementOutcome[] = [];
  for (const target of targets) {
    const placementType = CREATIVE_PLACEMENTS[target];
    const query = new URLSearchParams({ 'filter[placementType]': placementType, limit: '200', include: 'image,video' });
    if (placementGroup) query.set('filter[placementGroup]', placementGroup);
    const existing = await api.list(`/v1/appStoreVersionLocalizations/${localizationId}/placements?${query}`, 200);
    if (existing.truncated) throw new Error('Incomplete placement list; refusing to change placements.');
    const linked = (row: Resource) => { const data = row.relationships?.[RELATION[kind]]?.data; return data && !Array.isArray(data) ? data.id : undefined; };
    const same = existing.data.find(row => linked(row) === assetId);
    if (same) { placements.push({ target, placementId: same.id, status: 'exists', replaced: [] }); continue; }
    if (existing.data.length && !replace) throw new Error(`${target} already has placement(s) ${existing.data.map(r => r.id).join(', ')}. Pass --replace to swap them; assets stay in Asset Library.`);
    const replaced: string[] = [];
    for (const row of existing.data) { await api.delete(`/v1/appAssetLibraryPlacements/${row.id}`); replaced.push(row.id); }
    try {
      const created = await api.post('/v1/appAssetLibraryPlacements', { data: { type: 'appAssetLibraryPlacements',
        attributes: { placementType, ...(placementGroup ? { placementGroup } : {}) },
        relationships: { [RELATION[kind]]: { data: { type: RESOURCE[kind], id: assetId } },
          appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } } } });
      if (created.type !== 'appAssetLibraryPlacements' || !created.id) throw new Error('Invalid placement response.');
      placements.push({ target, placementId: created.id, status: 'created', replaced });
    } catch (error) {
      const message = error instanceof AppleError || error instanceof Error ? error.message : 'Placement failed';
      throw new Error(`${message}${replaced.length ? ` Removed placements before this failure: ${replaced.join(', ')}.` : ''}`);
    }
  }
  return { assetId, assetState, placements };
}
/** Removes a placement only after confirming it sits on this app's localization. The asset stays in Asset Library. */
export async function removeCreativePlacement(input: { account: Account; appId: string; versionId: string; localizationId: string; placementId: string }, api: AssetAPI): Promise<{ removed: string }> {
  const { account, appId, versionId, localizationId, placementId } = input;
  requireWrite(account, appId);
  if (![versionId, localizationId, placementId].every(validId)) throw new Error('Invalid version, localization or placement ID.');
  if ((await api.get(`/v1/appStoreVersions/${versionId}/app`)).id !== appId) throw new Error('Version does not belong to the requested app.');
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (localizations.truncated || !localizations.data.some(row => row.id === localizationId)) throw new Error('Localization is not verified for this version.');
  const query = new URLSearchParams({ 'filter[id]': placementId, limit: '1' });
  const placement = (await api.list(`/v1/appStoreVersionLocalizations/${localizationId}/placements?${query}`, 1)).data[0];
  if (placement?.id !== placementId) throw new Error('Placement is not on this localization.');
  if (!Object.values(CREATIVE_PLACEMENTS).includes(placement.attributes.placementType as never)) throw new Error('Not a Header or Search Results placement.');
  await api.delete(`/v1/appAssetLibraryPlacements/${placementId}`);
  return { removed: placementId };
}
/** Per-locale view of Header and Search Results for one version. */
export async function creativeOverview(api: Pick<AssetAPI, 'list'>, versionId: string) {
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  const rows = [];
  for (const localization of localizations.data) {
    const entry: Record<string, unknown> = { localizationId: localization.id, locale: localization.attributes.locale };
    for (const [target, placementType] of Object.entries(CREATIVE_PLACEMENTS)) {
      const query = new URLSearchParams({ 'filter[placementType]': placementType, include: 'image,video', limit: '50' });
      const placements = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/placements?${query}`, 50);
      entry[target] = placements.data.map(p => ({ placementId: p.id, group: p.attributes.placementGroup, state: p.attributes.state, mediaType: p.attributes.mediaType, relationships: p.relationships }));
    }
    rows.push(entry);
  }
  return { versionId, truncated: localizations.truncated, localizations: rows };
}
