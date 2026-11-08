import { accountIdentity, requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import type { PlanStore } from './plans.js';
import { assetLibraryId, imageState, type AssetAPI } from './asset-library.js';

/** States that hold no usable image: abandoned reservations and failed processing. */
const STALE = new Set(['AWAITING_UPLOAD', 'FAILED']);
export interface CleanupCandidate { kind: 'assetLibraryImage' | 'assetLibraryVideo' | 'legacyScreenshot'; id: string; state: string; createdAt: string; fileName?: string }
export interface CleanupReport {
  dryRun: boolean; olderThanHours: number; truncated: boolean;
  candidates: CleanupCandidate[]; deleted: string[]; skipped: { id: string; reason: string }[];
}
const legacyState = (r: Resource) => String((r.attributes.assetDeliveryState as { state?: string } | undefined)?.state ?? 'UNKNOWN');
const notFound = (error: unknown) => error instanceof AppleError && error.status === 404;

/** Dry runs need only reads; deletion additionally needs delete. */
export type CleanupAPI = Pick<AssetAPI, 'get' | 'list'> & Partial<Pick<AssetAPI, 'delete'>>;
async function hasPlacements(api: CleanupAPI, resource: string, id: string): Promise<boolean> {
  return (await api.list(`/v1/${resource}/${id}/placements?limit=1`, 1)).data.length > 0;
}

/**
 * Finds stale image reservations older than the cutoff. Asset Library images are discovered remotely;
 * legacy appScreenshots are only considered when this tool's own journal recorded them.
 * Dry-run unless execute is true; each candidate is re-read immediately before deletion.
 */
export async function cleanupStaleAssets(input: { account: Account; appId: string; olderThanHours?: number; execute?: boolean; now?: number },
  api: CleanupAPI, store?: PlanStore): Promise<CleanupReport> {
  const { account, appId, execute = false } = input;
  const olderThanHours = input.olderThanHours ?? 24;
  if (!Number.isFinite(olderThanHours) || olderThanHours < 1 || olderThanHours > 24 * 365) throw new Error('olderThanHours must be between 1 and 8760.');
  if (execute) requireWrite(account, appId);
  const cutoff = (input.now ?? Date.now()) - olderThanHours * 3_600_000;
  const report: CleanupReport = { dryRun: !execute, olderThanHours, truncated: false, candidates: [], deleted: [], skipped: [] };

  const libraryId = await assetLibraryId(api, appId);
  const query = new URLSearchParams({ 'filter[state]': [...STALE].join(','), sort: 'createdDate', limit: '200' });
  for (const [plural, resource, kind] of [['images', 'appAssetLibraryImages', 'assetLibraryImage'], ['videos', 'appAssetLibraryVideos', 'assetLibraryVideo']] as const) {
    const rows = await api.list(`/v1/appAssetLibraries/${libraryId}/${plural}?${query}`, 2000);
    report.truncated ||= rows.truncated;
    for (const row of rows.data) {
      const state = imageState(row);
      const created = Date.parse(String(row.attributes.createdDate ?? ''));
      if (!STALE.has(state)) continue;
      if (!Number.isFinite(created)) { report.skipped.push({ id: row.id, reason: 'Apple returned no creation date.' }); continue; }
      if (created > cutoff) continue;
      if (await hasPlacements(api, resource, row.id)) { report.skipped.push({ id: row.id, reason: 'Asset is still placed.' }); continue; }
      report.candidates.push({ kind, id: row.id, state, createdAt: new Date(created).toISOString(), fileName: row.attributes.fileName as string | undefined });
    }
  }
  if (store) {
    const identity = accountIdentity(account);
    for (const job of store.screenshotJobs(account.name, appId)) {
      if (job.identity !== identity || ['COMPLETE', 'deleted', 'gone'].includes(job.status)) continue;
      if (job.createdAt === undefined) { report.skipped.push({ id: job.id, reason: 'Legacy job has no recorded creation time.' }); continue; }
      if (job.createdAt > cutoff) continue;
      let remote: Resource;
      try { remote = await api.get(`/v1/appScreenshots/${job.id}`); }
      catch (error) { if (notFound(error)) { store.updateScreenshot(job.id, 'gone'); continue; } throw error; }
      const state = legacyState(remote);
      if (STALE.has(state)) report.candidates.push({ kind: 'legacyScreenshot', id: job.id, state, createdAt: new Date(job.createdAt).toISOString() });
    }
  }
  if (!execute) return report;
  const remove = api.delete?.bind(api);
  if (!remove) throw new Error('This client cannot delete Apple resources.');

  for (const candidate of report.candidates) {
    try {
      if (candidate.kind !== 'legacyScreenshot') {
        const resource = candidate.kind === 'assetLibraryImage' ? 'appAssetLibraryImages' : 'appAssetLibraryVideos';
        const fresh = await api.get(`/v1/${resource}/${candidate.id}`);
        if (!STALE.has(imageState(fresh))) { report.skipped.push({ id: candidate.id, reason: `State changed to ${imageState(fresh)}.` }); continue; }
        if (await hasPlacements(api, resource, candidate.id)) { report.skipped.push({ id: candidate.id, reason: 'Asset was placed meanwhile.' }); continue; }
        await remove(`/v1/${resource}/${candidate.id}`);
        if (store?.hasAsset(candidate.id)) store.updateAsset(candidate.id, 'deleted');
      } else {
        const fresh = await api.get(`/v1/appScreenshots/${candidate.id}`);
        if (!STALE.has(legacyState(fresh))) { report.skipped.push({ id: candidate.id, reason: `State changed to ${legacyState(fresh)}.` }); continue; }
        await remove(`/v1/appScreenshots/${candidate.id}`);
        store?.updateScreenshot(candidate.id, 'deleted');
      }
      report.deleted.push(candidate.id);
    } catch (error) {
      if (notFound(error)) { report.skipped.push({ id: candidate.id, reason: 'Already removed.' }); continue; }
      report.skipped.push({ id: candidate.id, reason: error instanceof Error ? error.message : 'Delete failed' });
    }
  }
  return report;
}
