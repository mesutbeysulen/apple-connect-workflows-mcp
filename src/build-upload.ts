import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { accountIdentity, requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import type { BuildJob, PlanStore } from './plans.js';

export interface BuildUploadAPI {
  post(path: string, body: unknown): Promise<Resource>;
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  patch(path: string, type: string, id: string, attrs: Record<string, unknown>): Promise<unknown>;
}
export interface BuildUploadResult { uploadId: string; fileId: string; state: string; resumedParts?: number }
interface Part { method: string; url: string; offset: number; length: number; expiration?: string; requestHeaders: { name: string; value: string }[] }
const validId = (id: string) => /^[A-Za-z0-9-]{1,128}$/.test(id);
const uploadState = (r: Resource) => String((r.attributes.state as { state?: string } | undefined)?.state ?? 'UNKNOWN');
const fileState = (r: Resource) => String((r.attributes.assetDeliveryState as { state?: string } | undefined)?.state ?? 'AWAITING_UPLOAD');
const problems = (r: Resource) => {
  const errors = (r.attributes.state as { errors?: unknown[] } | undefined)?.errors ?? (r.attributes.assetDeliveryState as { errors?: unknown[] } | undefined)?.errors;
  return Array.isArray(errors) && errors.length ? ` Apple errors: ${JSON.stringify(errors).slice(0, 800)}` : '';
};

function parts(value: unknown, size: number): Part[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Apple supplied no build upload operations.');
  const result = [...value as Part[]].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const part of result) {
    const url = new URL(part.url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.apple.com') || url.username || url.password) throw new Error('Unsafe build upload URL.');
    if (part.method !== 'PUT' || !Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.length) || part.length < 1 || part.offset !== end) throw new Error('Invalid build upload byte ranges.');
    if (!Array.isArray(part.requestHeaders) || part.requestHeaders.some(h => /^(authorization|cookie|host)$/i.test(h.name))) throw new Error('Unsafe build upload headers.');
    end += part.length;
  }
  if (end !== size) throw new Error('Build upload operations do not cover the whole file.');
  return result;
}
async function inspectIpa(filePath: string): Promise<{ size: number; sha256: string }> {
  if (!isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.ipa')) throw new Error('Use an absolute .ipa path.');
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1 || !Number.isSafeInteger(info.size)) throw new Error('Invalid IPA file.');
  const handle = await open(filePath, 'r');
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (!magic.equals(Buffer.from([0x50,0x4b,0x03,0x04]))) throw new Error('IPA must be a ZIP archive.');
  } finally { await handle.close(); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}

/**
 * Reserves a build upload, journals it, streams the IPA to Apple's signed URLs and commits its SHA-256.
 * Refuses to open a second reservation for a version/build pair that already has a live upload.
 */
export async function uploadBuild(input: { account: Account; appId: string; version: string; build: string; filePath: string },
  api: BuildUploadAPI, fetcher: typeof fetch = fetch, store?: PlanStore): Promise<BuildUploadResult> {
  const { account, appId, version, build, filePath } = input;
  requireWrite(account, appId);
  if (!/^\d+$/.test(appId) || !/^\d+(\.\d+){1,2}$/.test(version) || !/^[A-Za-z0-9.]+$/.test(build)) throw new Error('Use an app ID, numeric version/build and absolute .ipa path.');
  const { size, sha256 } = await inspectIpa(filePath);
  const query = new URLSearchParams({ 'filter[cfBundleShortVersionString]': version, 'filter[cfBundleVersion]': build, limit: '50' });
  const previous = await api.list(`/v1/apps/${appId}/buildUploads?${query}`, 50);
  const live = previous.data.find(row => uploadState(row) !== 'FAILED');
  if (previous.truncated || live) throw new Error(`Build upload ${live?.id ?? '(unknown)'} already exists for ${version} (${build}) in state ${live ? uploadState(live) : 'unknown'}. Use build-resume or build-wait instead of a new upload.`);
  const reserved = await api.post('/v1/buildUploads', { data: { type: 'buildUploads', attributes: {
    cfBundleShortVersionString: version, cfBundleVersion: build, platform: 'IOS',
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
        assetType: 'ASSET', fileName: basename(job.filePath), fileSize: job.size, uti: 'com.apple.ipa',
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
      const done = new Set(job.doneParts);
      for (const part of parts(file.attributes.uploadOperations, job.size)) {
        if (done.has(part.offset)) { skipped++; continue; }
        if (part.expiration && Date.parse(part.expiration) <= Date.now()) throw new Error('Signed build upload URLs expired; Apple must issue new upload operations.');
        const response = await fetcher(part.url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10 * 60_000),
          headers: Object.fromEntries(part.requestHeaders.map(h => [h.name, h.value])),
          body: createReadStream(job.filePath, { start: part.offset, end: part.offset + part.length - 1 }), duplex: 'half',
        } as unknown as RequestInit);
        if (!response.ok) throw new Error(`Build part transfer failed: HTTP ${response.status}.`);
        await response.body?.cancel();
        store?.markBuildPart(job.id, part.offset);
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
