import { AppleError, type Resource } from './apple.js';
import { validId } from './apple-rules.js';

export interface BuildStatusAPI { get(path: string): Promise<Resource> }
export interface BuildStatus {
  uploadId: string; uploadState: string; buildId: string | null; processingState: string | null;
  done: boolean; ok: boolean; problems: unknown[];
}
const TERMINAL_BUILD = new Set(['VALID', 'INVALID', 'FAILED']);

/** Reads the upload and, once Apple links it, the processed build's processingState. */
export async function buildStatus(api: BuildStatusAPI, uploadId: string): Promise<BuildStatus> {
  if (!validId(uploadId)) throw new Error('Invalid build upload ID.');
  const upload = await api.get(`/v1/buildUploads/${uploadId}?include=build`);
  const state = upload.attributes.state as { state?: string; errors?: unknown[] } | undefined;
  const uploadState = String(state?.state ?? 'UNKNOWN');
  const link = upload.relationships?.build?.data;
  const buildId = link && !Array.isArray(link) ? link.id : null;
  const problems = Array.isArray(state?.errors) ? state.errors : [];
  if (uploadState === 'FAILED') return { uploadId, uploadState, buildId, processingState: null, done: true, ok: false, problems };
  if (!buildId) return { uploadId, uploadState, buildId, processingState: null, done: false, ok: false, problems };
  const build = await api.get(`/v1/builds/${buildId}`);
  const processingState = String(build.attributes.processingState ?? 'UNKNOWN');
  return { uploadId, uploadState, buildId, processingState, done: TERMINAL_BUILD.has(processingState), ok: processingState === 'VALID', problems };
}

/** Polls until the build is VALID/INVALID/FAILED or the upload fails. Read-only. */
export async function waitForBuild(api: BuildStatusAPI, uploadId: string, options: {
  timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onProgress?: (status: BuildStatus) => void; onRetry?: (error: unknown) => void;
} = {}): Promise<BuildStatus> {
  const { timeoutMs = 60 * 60_000, intervalMs = 30_000, now = Date.now } = options;
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  if (!(intervalMs >= 1000) || !(timeoutMs >= intervalMs)) throw new Error('Interval must be at least 1s and not exceed the timeout.');
  const deadline = now() + timeoutMs;
  let last = '';
  for (;;) {
    let status: BuildStatus;
    try { status = await buildStatus(api, uploadId); }
    catch (error) {
      // Client errors are final; a network blip or Apple outage must not end a long wait.
      const final = error instanceof AppleError && error.status >= 400 && error.status < 500 && error.status !== 429;
      if (final || now() + intervalMs > deadline) throw error;
      options.onRetry?.(error);
      await sleep(intervalMs);
      continue;
    }
    const key = `${status.uploadState}/${status.processingState}`;
    if (key !== last) { options.onProgress?.(status); last = key; }
    if (status.done) return status;
    if (now() + intervalMs > deadline) throw new Error(`Timed out waiting for build processing; last state ${key}. Run build-wait again later.`);
    await sleep(intervalMs);
  }
}
