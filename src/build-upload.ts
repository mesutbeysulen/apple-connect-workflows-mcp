import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { accountIdentity, requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import type { BuildJob, PlanStore } from './plans.js';
import { validId } from './apple-rules.js';
import { putFilePart, validateOperations } from './upload-transfer.js';

export interface BuildUploadAPI {
  post(path: string, body: unknown): Promise<Resource>;
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  patch(path: string, type: string, id: string, attrs: Record<string, unknown>): Promise<unknown>;
}
export interface BuildUploadResult { uploadId: string; fileId: string; state: string; resumedParts?: number }
const uploadState = (r: Resource) => String((r.attributes.state as { state?: string } | undefined)?.state ?? 'UNKNOWN');
const fileState = (r: Resource) => String((r.attributes.assetDeliveryState as { state?: string } | undefined)?.state ?? 'AWAITING_UPLOAD');
const problems = (r: Resource) => {
  const errors = (r.attributes.state as { errors?: unknown[] } | undefined)?.errors ?? (r.attributes.assetDeliveryState as { errors?: unknown[] } | undefined)?.errors;
  return Array.isArray(errors) && errors.length ? ` Apple errors: ${JSON.stringify(errors).slice(0, 800)}` : '';
};

async function inspectIpa(filePath: string): Promise<{ size: number; sha256: string }> {
  const lower = filePath.toLowerCase();
  if (!isAbsolute(filePath) || !(lower.endsWith('.ipa') || lower.endsWith('.pkg'))) throw new Error('Use an absolute .ipa or .pkg path.');
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1 || !Number.isSafeInteger(info.size)) throw new Error('Invalid IPA file.');
  const handle = await open(filePath, 'r');
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (lower.endsWith('.ipa') ? !magic.equals(Buffer.from([0x50,0x4b,0x03,0x04])) : !magic.equals(Buffer.from('xar!'))) throw new Error(lower.endsWith('.ipa') ? 'IPA must be a ZIP archive.' : 'PKG must be a xar archive.');
  } finally { await handle.close(); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}

/**
 * Reserves a build upload, journals it, streams the IPA to Apple's signed URLs and commits its SHA-256.
 * Refuses to open a second reservation for a version/build pair that already has a live upload.
 */
export async function uploadBuild(input: { account: Account; appId: string; version: string; build: string; filePath: string; platform?: string },
  api: BuildUploadAPI, fetcher: typeof fetch = fetch, store?: PlanStore): Promise<BuildUploadResult> {
  const { account, appId, version, build, filePath, platform = 'IOS' } = input;
  requireWrite(account, appId);
  if (!/^\d+$/.test(appId) || !/^\d+(\.\d+){1,2}$/.test(version) || !/^[A-Za-z0-9.]+$/.test(build)) throw new Error('Use an app ID and numeric version/build.');
  if (!['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'].includes(platform)) throw new Error('Platform must be IOS, MAC_OS, TV_OS or VISION_OS.');
  if ((platform === 'MAC_OS') !== filePath.toLowerCase().endsWith('.pkg')) throw new Error('MAC_OS uses a .pkg file; other platforms use .ipa.');
  const { size, sha256 } = await inspectIpa(filePath);
  const query = new URLSearchParams({ 'filter[cfBundleShortVersionString]': version, 'filter[cfBundleVersion]': build, 'filter[platform]': platform, limit: '50' });
  const previous = await api.list(`/v1/apps/${appId}/buildUploads?${query}`, 50);
  const live = previous.data.find(row => uploadState(row) !== 'FAILED');
  if (previous.truncated) throw new Error('Incomplete build upload list; refusing an uncertain duplicate reservation.');
  if (live) {
    const state = uploadState(live);
    const next = state === 'AWAITING_UPLOAD' ? 'Continue it with build-resume, or remove it with build-cancel if it has no local journal.' : 'Follow it with build-wait.';
    throw new Error(`Build upload ${live.id} already exists for ${version} (${build}) in state ${state}. ${next}`);
  }
  const reserved = await api.post('/v1/buildUploads', { data: { type: 'buildUploads', attributes: {
    cfBundleShortVersionString: version, cfBundleVersion: build, platform,
  }, relationships: { app: { data: { type: 'apps', id: appId } } } } });
  if (reserved.type !== 'buildUploads' || !reserved.id || !validId(reserved.id)) throw new Error('Invalid build upload reservation.');
  const job: BuildJob = { id: reserved.id, account: account.name, identity: accountIdentity(account), appId, version, build, filePath,
    sha256, size, createdAt: Date.now(), fileId: null, doneParts: [], status: 'reserved', error: null };
  store?.saveBuild(job);
  return continueBuild(job, api, fetcher, store);
}

async function continueBuild(job: BuildJob, api: BuildUploadAPI, fetcher: typeof fetch, store?: PlanStore): Promise<BuildUploadResult> {
  let fileId = job.fileId;
  try {
    let file: Resource | undefined;
    if (!fileId) {
      const existing = await api.list(`/v1/buildUploads/${job.id}/buildUploadFiles?limit=10`, 10);
      file = existing.data.find(row => row.attributes.assetType === 'ASSET' && row.attributes.fileSize === job.size);
      file ??= await api.post('/v1/buildUploadFiles', { data: { type: 'buildUploadFiles', attributes: {
        assetType: 'ASSET', fileName: basename(job.filePath), fileSize: job.size, uti: job.filePath.toLowerCase().endsWith('.pkg') ? 'com.apple.pkg' : 'com.apple.ipa',
      }, relationships: { buildUpload: { data: { type: 'buildUploads', id: job.id } } } } });
      if (file.type !== 'buildUploadFiles' || !file.id || !validId(file.id)) throw new Error('Invalid build file reservation.');
      fileId = file.id;
      store?.setBuildFile(job.id, fileId);
      job = { ...job, fileId, doneParts: [] };
    }
    file ??= await api.get(`/v1/buildUploadFiles/${fileId}`);
    const state = fileState(file);
    if (state === 'FAILED') throw new Error(`Apple reports the build file failed.${problems(file)}`);
    let skipped = 0;
    if (state === 'AWAITING_UPLOAD') {
      for (const part of validateOperations(file.attributes.uploadOperations, job.size)) {
        // Skip only a range sent to this same session with the same boundaries; re-issued operations resend it.
        const path = new URL(part.url).pathname;
        if (job.doneParts.some(p => p.offset === part.offset && p.length === part.length && p.path === path)) { skipped++; continue; }
        if (part.expiration && Date.parse(part.expiration) <= Date.now()) throw new Error('Signed build upload URLs expired; Apple must issue new upload operations.');
        await putFilePart(part, job.filePath, fetcher);
        store?.markBuildPart(job.id, { offset: part.offset, length: part.length, path });
      }
      const after = await stat(job.filePath);
      if (after.size !== job.size) throw new Error('IPA changed during upload.');
      store?.updateBuild(job.id, 'transferred');
      await api.patch(`/v1/buildUploadFiles/${fileId}`, 'buildUploadFiles', fileId,
        { uploaded: true, sourceFileChecksums: { file: { hash: job.sha256, algorithm: 'SHA_256' } } });
    }
    const status = await api.get(`/v1/buildUploads/${job.id}`);
    const final = uploadState(status) === 'UNKNOWN' ? 'PROCESSING' : uploadState(status);
    if (final === 'FAILED') throw new Error(`Apple rejected the build upload.${problems(status)}`);
    store?.updateBuild(job.id, final);
    return { uploadId: job.id, fileId, state: final, ...(skipped ? { resumedParts: skipped } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Build upload failed';
    store?.updateBuild(job.id, 'needs_reconciliation', message);
    throw new Error(`${message} Build upload ID: ${job.id}. Inspect it with build-wait or continue with build-resume.`);
  }
}

/** Continues a journaled IPA upload: verifies the file is unchanged and skips byte ranges already sent. */
export async function resumeBuild(uploadId: string, account: Account, store: PlanStore, api: BuildUploadAPI, fetcher: typeof fetch = fetch): Promise<BuildUploadResult> {
  if (!validId(uploadId)) throw new Error('Invalid build upload ID.');
  const job = store.buildJob(uploadId);
  if (job.account !== account.name || job.identity !== accountIdentity(account)) throw new Error('Build job belongs to a different account identity.');
  requireWrite(account, job.appId);
  const { size, sha256 } = await inspectIpa(job.filePath);
  if (size !== job.size || sha256 !== job.sha256) throw new Error('IPA changed since the upload started; start a new upload with a new build number.');
  const remote = await api.get(`/v1/buildUploads/${uploadId}`);
  const state = uploadState(remote);
  if (state === 'FAILED') { store.updateBuild(uploadId, 'FAILED'); throw new Error(`Build upload ${uploadId} failed at Apple.${problems(remote)}`); }
  if (state === 'PROCESSING' || state === 'COMPLETE') {
    store.updateBuild(uploadId, state);
    return { uploadId, fileId: job.fileId ?? '', state };
  }
  return continueBuild(job, api, fetcher, store);
}
/** Removes a stuck reservation, including one with no local journal. Only unfinished or failed uploads qualify. */
export async function cancelBuildUpload(input: { account: Account; appId: string; uploadId: string }, api: Pick<BuildUploadAPI, 'list'> & { delete(path: string): Promise<void> }, store?: PlanStore): Promise<{ cancelled: string }> {
  const { account, appId, uploadId } = input;
  requireWrite(account, appId);
  if (!validId(uploadId) || !/^\d+$/.test(appId)) throw new Error('Invalid app or build upload ID.');
  const uploads = await api.list(`/v1/apps/${appId}/buildUploads?limit=200`, 2000);
  const upload = uploads.data.find(row => row.id === uploadId);
  if (!upload) throw new Error('Build upload does not belong to this app.');
  const state = uploadState(upload);
  if (state !== 'AWAITING_UPLOAD' && state !== 'FAILED') throw new Error(`Only AWAITING_UPLOAD or FAILED uploads can be cancelled; this one is ${state}.`);
  await api.delete(`/v1/buildUploads/${uploadId}`);
  if (store?.hasBuild(uploadId)) store.updateBuild(uploadId, 'cancelled');
  return { cancelled: uploadId };
}
