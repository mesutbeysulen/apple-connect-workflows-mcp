import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { uploadScreenshot, type ScreenshotAPI } from '../src/screenshots.js';
import type { Account } from '../src/config.js';

const account: Account = { name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] };
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('example')]);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-')); const filePath = join(dir, 'image.png'); writeFileSync(filePath, png);
  const requests: { method: string; url: string; body?: unknown }[] = [];
  let uploadUrl = 'https://store-030.blobstore.apple.com/upload?token=secret';
  const api: ScreenshotAPI = {
    get: async path => path.endsWith('/app') ? { id: '123', type: 'apps', attributes: {} } : { id: 'version', type: 'appStoreVersions', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION', assetDeliveryState: { state: 'COMPLETE' } } },
    list: async path => ({ data: [{ id: path.includes('appScreenshotSets') ? 'set-1' : 'loc', type: 'items', attributes: {} }], truncated: false }),
    post: async (path, body) => { requests.push({ method: 'POST', url: path, body }); return { id: 'screenshot', type: 'appScreenshots', attributes: { uploadOperations: [
      { method: 'PUT', url: uploadUrl, offset: 8, length: png.length - 8, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
      { method: 'PUT', url: uploadUrl, offset: 0, length: 8, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
    ] } }; },
    patch: async (path, _type, _id, attrs) => { requests.push({ method: 'PATCH', url: path, body: attrs }); return {}; },
  };
  const parts: Buffer[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ method: String(init.method), url });
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(init.redirect, 'error');
    parts.push(Buffer.from(init.body as Uint8Array));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { dir, filePath, api, fetcher, requests, parts, setUploadUrl: (value: string) => uploadUrl = value };
}
test('uploads all Apple byte ranges, commits checksum and reports verified state', async () => {
  const f = fixture();
  try {
    const result = await uploadScreenshot({ account, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: f.filePath }, f.api, f.fetcher);
    assert.deepEqual(result, { screenshotId: 'screenshot', state: 'COMPLETE' });
    assert.equal(f.requests[0]!.method, 'POST');
    assert.deepEqual(f.parts, [png.subarray(8), png.subarray(0,8)]);
    assert.deepEqual(f.requests.at(-1)!.body, { uploaded: true, sourceFileChecksum: createHash('md5').update(png).digest('hex') });
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('rejects unsafe upload URL before sending file bytes', async () => {
  const f = fixture(); f.setUploadUrl('https://attacker.example/upload');
  try {
    await assert.rejects(uploadScreenshot({ account, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: f.filePath }, f.api, f.fetcher), /Unsafe Apple upload URL/);
    assert.equal(f.requests.filter(x => x.method === 'PUT').length, 0);
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('write allowlist and image signature reject before any Apple call', async () => {
  const f = fixture();
  try {
    await assert.rejects(uploadScreenshot({ account: { ...account, readOnly: true }, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: f.filePath }, f.api, f.fetcher), /read-only/);
    writeFileSync(f.filePath, 'not an image');
    await assert.rejects(uploadScreenshot({ account, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: f.filePath }, f.api, f.fetcher), /signature/);
    assert.equal(f.requests.length, 0);
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('persists a reservation and resumes it without creating another screenshot', async () => {
  const f = fixture();
  const { PlanStore } = await import('../src/plans.js');
  const dbPath = join(f.dir, 'jobs.sqlite');
  let store = new PlanStore(dbPath);
  let reservation: Awaited<ReturnType<ScreenshotAPI['post']>> | undefined;
  let state = 'AWAITING_UPLOAD';
  let posts = 0;
  const api: ScreenshotAPI = {
    ...f.api,
    post: async (path, body) => { posts++; reservation = await f.api.post(path, body); return reservation; },
    get: async path => path.endsWith('/screenshot') ? {
      ...reservation!, attributes: { ...reservation!.attributes, assetDeliveryState: { state } },
    } : f.api.get(path),
    patch: async (path, type, id, attrs) => { state = 'UPLOAD_COMPLETE'; return f.api.patch(path, type, id, attrs); },
  };
  let fail = true;
  const fetcher = (async (url: string, init: RequestInit) => {
    if (fail) { fail = false; return new Response(null, { status: 403 }); }
    return f.fetcher(url, init);
  }) as typeof fetch;
  try {
    await assert.rejects(uploadScreenshot({ account, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: f.filePath }, api, fetcher, store), /Screenshot job: screenshot/);
    assert.equal(store.screenshot('screenshot').status, 'needs_reconciliation');
    store.close(); store = new PlanStore(dbPath);
    const result = await (await import('../src/screenshots.js')).resumeScreenshot('screenshot', account, store, api, fetcher);
    assert.deepEqual(result, { screenshotId: 'screenshot', state: 'UPLOAD_COMPLETE' });
    assert.equal(posts, 1);
    assert.equal(store.screenshot('screenshot').status, 'UPLOAD_COMPLETE');
  } finally { store.close(); rmSync(f.dir, { recursive: true }); }
});
test('resume rejects modified source bytes', async () => {
  const f = fixture();
  const { PlanStore } = await import('../src/plans.js');
  const store = new PlanStore(':memory:');
  try {
    store.saveScreenshot({ id: 'screenshot', account: 'team', identity: (await import('../src/config.js')).accountIdentity(account), appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: f.filePath, sha256: 'old', status: 'reserved', error: null });
    await assert.rejects((await import('../src/screenshots.js')).resumeScreenshot('screenshot', account, store, f.api, f.fetcher), /Source image changed/);
    assert.equal(f.requests.length, 0);
  } finally { store.close(); rmSync(f.dir, { recursive: true }); }
});
