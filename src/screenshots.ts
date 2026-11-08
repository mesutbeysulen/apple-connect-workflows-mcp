import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { accountIdentity, requireWrite, type Account } from './config.js';
import { PlanStore, type ScreenshotJob } from './plans.js';
import { AppleClient, createTokenProvider, type Resource } from './apple.js';

export interface ScreenshotAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
}
export const EDITABLE_VERSION_STATES = ['PREPARE_FOR_SUBMISSION', 'INVALID_BINARY', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED'];
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const validId = (id: string) => /^[A-Za-z0-9-]{1,128}$/.test(id);
interface UploadOperation { method: string; url: string; offset: number; length: number; requestHeaders: { name: string; value: string }[] }
export function validateOperations(input: unknown, length: number): UploadOperation[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Apple provided no upload operations.');
  const operations = input as UploadOperation[];
  let position = 0;
  for (const op of [...operations].sort((a, b) => a.offset - b.offset)) {
    const url = new URL(op.url);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.apple.com')) throw new Error('Unsafe Apple upload URL.');
    if (op.method !== 'PUT' || !Number.isSafeInteger(op.offset) || !Number.isSafeInteger(op.length) || op.length <= 0 || op.offset !== position) throw new Error('Invalid upload byte ranges.');
    if (!Array.isArray(op.requestHeaders) || op.requestHeaders.some(h => /^(authorization|cookie|host)$/i.test(h.name))) throw new Error('Unsafe upload headers.');
    position += op.length;
  }
  if (position !== length) throw new Error('Upload instructions do not cover the whole file.');
  return operations;
}
/** Sends every validated byte range to Apple's signed URLs. Never forwards API credentials. */
export async function sendParts(operations: unknown, bytes: Buffer, fetcher: typeof fetch): Promise<void> {
  for (const op of validateOperations(operations, bytes.length)) {
    const response = await fetcher(op.url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value])), body: new Uint8Array(bytes.subarray(op.offset, op.offset + op.length)) });
    if (!response.ok) throw new Error(`Image byte transfer failed: HTTP ${response.status}. Signed URL may have expired.`);
    await response.body?.cancel();
  }
}
/** Reads a local PNG/JPEG and verifies its signature matches its extension. */
export async function readImage(filePath: string): Promise<{ name: string; bytes: Buffer; sha256: string }> {
  if (!isAbsolute(filePath)) throw new Error('Use an absolute image path.');
  const file = await stat(filePath);
  if (!file.isFile() || file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new Error('Screenshot file must be 1 byte to 30 MiB.');
  const name = basename(filePath);
  if (!/\.(png|jpe?g)$/i.test(name)) throw new Error('Screenshot must be PNG or JPEG.');
  const handle = await open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(file.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== file.size) throw new Error('Screenshot changed while reading.');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (name.toLowerCase().endsWith('.png') ? !png : !jpeg) throw new Error('File extension and image signature do not match.');
    return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
/** Re-reads a recorded source image and refuses to continue if its bytes changed. */
export async function rereadImage(filePath: string, sha256: string): Promise<Buffer> {
  const file = await stat(filePath);
  if (!file.isFile() || file.size > MAX_IMAGE_BYTES) throw new Error('Source image is missing or invalid.');
  const bytes = await readFile(filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Source image changed; cannot resume upload.');
  return bytes;
}
/** Confirms version→app ownership, editable state and that the localization belongs to the version. */
export async function verifyLocalization(api: Pick<ScreenshotAPI, 'get' | 'list'>, appId: string, versionId: string, localizationId: string): Promise<void> {
  if (![appId, versionId, localizationId].every(validId)) throw new Error('Invalid app, version or localization ID.');
  const app = await api.get(`/v1/appStoreVersions/${versionId}/app`);
  if (app.id !== appId) throw new Error('Version does not belong to the requested app.');
  const version = await api.get(`/v1/appStoreVersions/${versionId}`);
  const state = version.attributes.appStoreState;
  if (!EDITABLE_VERSION_STATES.includes(String(state))) throw new Error(`Version is not editable: ${state}`);
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (localizations.truncated || !localizations.data.some(row => row.id === localizationId)) throw new Error('Localization is not verified for this version.');
}
export async function verifySet(api: Pick<ScreenshotAPI, 'list'>, localizationId: string, setId: string): Promise<void> {
  if (!validId(setId)) throw new Error('Invalid screenshot set ID.');
  const sets = await api.list(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=200`, 200);
  if (sets.truncated || !sets.data.some(row => row.id === setId)) throw new Error('Screenshot set is not verified for this localization.');
}
export async function uploadScreenshot(input: { account: Account; appId: string; versionId: string; localizationId: string; setId: string; filePath: string },
  api: ScreenshotAPI, fetcher: typeof fetch = fetch, store?: PlanStore): Promise<{ screenshotId: string; state: string }> {
  const { account, appId, versionId, localizationId, setId, filePath } = input;
  requireWrite(account, appId);
  if (![setId, versionId, localizationId].every(validId) || !isAbsolute(filePath)) throw new Error('Use a valid screenshot set ID and absolute file path.');
  const { name, bytes, sha256 } = await readImage(filePath);
  await verifyLocalization(api, appId, versionId, localizationId);
  await verifySet(api, localizationId, setId);
  const reserved = await api.post('/v1/appScreenshots', { data: { type: 'appScreenshots', attributes: { fileName: name, fileSize: bytes.length }, relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } } } });
  if (!reserved.id || reserved.type !== 'appScreenshots') throw new Error('Invalid screenshot reservation response.');
  const job: ScreenshotJob = { id: reserved.id, account: account.name, identity: accountIdentity(account), appId,
    versionId, localizationId, setId, filePath, sha256, createdAt: Date.now(), status: 'reserved', error: null };
  store?.saveScreenshot(job);
  return transfer(job, bytes, reserved, api, fetcher, store);
}
const deliveryState = (resource: Resource, fallback: string) =>
  String((resource.attributes.assetDeliveryState as { state?: string } | undefined)?.state ?? fallback);
async function transfer(job: ScreenshotJob, bytes: Buffer, reservation: Resource,
  api: ScreenshotAPI, fetcher: typeof fetch, store?: PlanStore): Promise<{ screenshotId: string; state: string }> {
  try {
    const initial = deliveryState(reservation, 'AWAITING_UPLOAD');
    if (initial === 'FAILED') throw new Error('Apple reports screenshot processing failure.');
    if (initial === 'AWAITING_UPLOAD') {
      await sendParts(reservation.attributes.uploadOperations, bytes, fetcher);
      store?.updateScreenshot(job.id, 'transferred');
      await api.patch(`/v1/appScreenshots/${job.id}`, 'appScreenshots', job.id,
        { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') });
    }
    const state = deliveryState(await api.get(`/v1/appScreenshots/${job.id}`), 'UNKNOWN');
    if (state === 'FAILED') throw new Error('Apple rejected screenshot processing.');
    store?.updateScreenshot(job.id, state);
    return { screenshotId: job.id, state };
  } catch (error) {
    store?.updateScreenshot(job.id, 'needs_reconciliation', error instanceof Error ? error.message : 'Upload failed');
    throw new Error(`${error instanceof Error ? error.message : 'Upload failed'} Screenshot job: ${job.id}`);
  }
}
export async function resumeScreenshot(id: string, account: Account, store: PlanStore, api: ScreenshotAPI,
  fetcher: typeof fetch = fetch): Promise<{ screenshotId: string; state: string }> {
  if (!validId(id)) throw new Error('Invalid screenshot job ID.');
  const job = store.screenshot(id);
  if (job.account !== account.name || job.identity !== accountIdentity(account)) throw new Error('Screenshot job belongs to a different account identity.');
  requireWrite(account, job.appId);
  const bytes = await rereadImage(job.filePath, job.sha256);
  const reservation = await api.get(`/v1/appScreenshots/${job.id}`);
  const state = deliveryState(reservation, 'UNKNOWN');
  if (state === 'COMPLETE' || state === 'UPLOAD_COMPLETE') {
    store.updateScreenshot(id, state);
    return { screenshotId: id, state };
  }
  if (state !== 'AWAITING_UPLOAD') throw new Error(`Cannot resume Apple screenshot state ${state}; job ${id}.`);
  return transfer(job, bytes, reservation, api, fetcher, store);
}
export function screenshotClient(account: Account): AppleClient {
  return new AppleClient(createTokenProvider(account));
}
