import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { uploadBuild, type BuildUploadAPI } from '../src/build-upload.js';
import type { Account } from '../src/config.js';
const account: Account = { name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] };
const bytes = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.from('buildbytes')]);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'build-')); const filePath = join(dir, 'app.ipa'); writeFileSync(filePath, bytes);
  let partsUrl = 'https://store.apple.com/upload'; let posts = 0; let committed: unknown;
  const api: BuildUploadAPI = {
    post: async (_path, body) => { posts++; if (posts === 1) {
      assert.deepEqual((body as any).data.relationships.app.data, { type: 'apps', id: '123' });
      return { id: 'upload', type: 'buildUploads', attributes: {} };
    } return { id: 'file', type: 'buildUploadFiles', attributes: { uploadOperations: [
      { method: 'PUT', url: partsUrl, offset: 4, length: bytes.length - 4, requestHeaders: [] },
      { method: 'PUT', url: partsUrl, offset: 0, length: 4, requestHeaders: [] },
    ] } }; },
    get: async () => ({ id: 'upload', type: 'buildUploads', attributes: { state: { state: 'PROCESSING' } } }),
    list: async () => ({ data: [], truncated: false }),
    patch: async (_path, _type, _id, attrs) => { committed = attrs; return {}; },
  };
  const chunks: Buffer[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).has('authorization'), false);
    const stream = init.body as unknown as AsyncIterable<Buffer>;
    const pieces: Buffer[] = [];
    for await (const piece of stream) pieces.push(piece);
    chunks.push(Buffer.concat(pieces));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { dir, filePath, api, fetcher, chunks, setUrl: (x: string) => partsUrl = x, get posts() { return posts; }, get committed() { return committed; } };
}
test('reserves, streams every byte range and commits SHA-256', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, f.api, f.fetcher), { uploadId: 'upload', fileId: 'file', state: 'PROCESSING' });
    assert.deepEqual(f.chunks, [bytes.subarray(0,4), bytes.subarray(4)]);
    assert.deepEqual(f.committed, { uploaded: true, sourceFileChecksums: { file: { hash: createHash('sha256').update(bytes).digest('hex'), algorithm: 'SHA_256' } } });
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('invalid IPA and unsafe upload URL are rejected', async () => {
  const f = fixture();
  try {
    writeFileSync(f.filePath, 'invalid');
    await assert.rejects(uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, f.api, f.fetcher), /ZIP/);
    assert.equal(f.posts, 0);
    writeFileSync(f.filePath, bytes); f.setUrl('https://other.example/upload');
    await assert.rejects(uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, f.api, f.fetcher), /Unsafe build upload URL/);
    assert.equal(f.chunks.length, 0);
  } finally { rmSync(f.dir, { recursive: true }); }
});

import { resumeBuild } from '../src/build-upload.js';
import { waitForBuild, buildStatus } from '../src/build-status.js';
import { distributeToGroups } from '../src/testflight.js';
import { PlanStore } from '../src/plans.js';
const ops = [{ method: 'PUT', url: 'https://store.apple.com/1', offset: 0, length: 4, requestHeaders: [] }, { method: 'PUT', url: 'https://store.apple.com/2', offset: 4, length: bytes.length - 4, requestHeaders: [] }];
function resumable() {
  const dir = mkdtempSync(join(tmpdir(), 'build-')); const filePath = join(dir, 'app.ipa'); writeFileSync(filePath, bytes);
  let commits = 0; let posts = 0; let uploadState = 'AWAITING_UPLOAD';
  const api: BuildUploadAPI = {
    post: async (path) => { posts++; return path === '/v1/buildUploads' ? { id: 'upload', type: 'buildUploads', attributes: {} } : { id: 'file', type: 'buildUploadFiles', attributes: { uploadOperations: ops } }; },
    get: async path => path.startsWith('/v1/buildUploadFiles/') ? { id: 'file', type: 'buildUploadFiles', attributes: { uploadOperations: ops, assetDeliveryState: { state: 'AWAITING_UPLOAD' } } } : { id: 'upload', type: 'buildUploads', attributes: { state: { state: uploadState } } },
    list: async () => ({ data: [], truncated: false }),
    patch: async () => { commits++; uploadState = 'PROCESSING'; return {}; },
  };
  const urls: string[] = []; let failOn: string | undefined = 'https://store.apple.com/2';
  const fetcher = (async (url: string, init: RequestInit) => {
    for await (const _ of init.body as unknown as AsyncIterable<Buffer>);
    if (url === failOn) { failOn = undefined; return new Response(null, { status: 500 }); }
    urls.push(url); return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { dir, filePath, api, fetcher, urls, get commits() { return commits; }, get posts() { return posts; }, setState: (s: string) => uploadState = s };
}
test('interrupted IPA upload resumes from the failed part without a new reservation', async () => {
  const f = resumable(); const store = new PlanStore(':memory:');
  try {
    await assert.rejects(uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, f.api, f.fetcher, store), /Build upload ID: upload/);
    assert.equal(store.buildJob('upload').status, 'needs_reconciliation');
    assert.deepEqual(store.buildJob('upload').doneParts, [0]);
    const posts = f.posts;
    const result = await resumeBuild('upload', account, store, f.api, f.fetcher);
    assert.deepEqual(result, { uploadId: 'upload', fileId: 'file', state: 'PROCESSING', resumedParts: 1 });
    assert.deepEqual(f.urls, ['https://store.apple.com/1', 'https://store.apple.com/2']);
    assert.equal(f.posts, posts); assert.equal(f.commits, 1);
    assert.deepEqual(await resumeBuild('upload', account, store, f.api, f.fetcher), { uploadId: 'upload', fileId: 'file', state: 'PROCESSING' });
    assert.equal(f.commits, 1);
  } finally { store.close(); rmSync(f.dir, { recursive: true }); }
});
test('resume refuses a changed IPA or another account and failed uploads', async () => {
  const f = resumable(); const store = new PlanStore(':memory:');
  try {
    await assert.rejects(uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, f.api, f.fetcher, store));
    await assert.rejects(resumeBuild('upload', { ...account, keyId: 'ZZZZZZZZZZ' }, store, f.api, f.fetcher), /different account/);
    f.setState('FAILED');
    await assert.rejects(resumeBuild('upload', account, store, f.api, f.fetcher), /failed at Apple/);
    writeFileSync(f.filePath, Buffer.concat([bytes, Buffer.from('x')]));
    await assert.rejects(resumeBuild('upload', account, store, f.api, f.fetcher), /IPA changed/);
  } finally { store.close(); rmSync(f.dir, { recursive: true }); }
});
test('a live upload for the same version and build blocks another reservation; a failed one does not', async () => {
  const f = fixture();
  const row = (state: string) => ({ id: 'old', type: 'buildUploads', attributes: { state: { state } } });
  try {
    const live = { ...f.api, list: async () => ({ data: [row('PROCESSING')], truncated: false }) };
    await assert.rejects(uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, live, f.fetcher), /old already exists/);
    assert.equal(f.posts, 0);
    const failed = { ...f.api, list: async () => ({ data: [row('FAILED')], truncated: false }) };
    assert.equal((await uploadBuild({ account, appId: '123', version: '1.2.3', build: '42', filePath: f.filePath }, failed, f.fetcher)).uploadId, 'upload');
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('build wait follows upload then build processing, and times out honestly', async () => {
  const states = [{ upload: 'PROCESSING' }, { upload: 'COMPLETE', build: 'PROCESSING' }, { upload: 'COMPLETE', build: 'VALID' }];
  let at = 0; let slept = 0; let clock = 0; const seen: string[] = [];
  const api = { get: async (path: string) => {
    if (path.startsWith('/v1/builds/')) return { id: 'b', type: 'builds', attributes: { processingState: states[at]!.build } };
    at = Math.min(slept, states.length - 1);
    const s = states[at]!;
    return { id: 'u', type: 'buildUploads', attributes: { state: { state: s.upload } }, ...(s.build ? { relationships: { build: { data: { id: 'b', type: 'builds' } } } } : {}) };
  } };
  const result = await waitForBuild(api, 'u', { intervalMs: 1000, sleep: async () => { slept++; clock += 1000; }, now: () => clock, onProgress: s => seen.push(`${s.uploadState}/${s.processingState}`) });
  assert.deepEqual(result, { uploadId: 'u', uploadState: 'COMPLETE', buildId: 'b', processingState: 'VALID', done: true, ok: true, problems: [] });
  assert.deepEqual(seen, ['PROCESSING/null', 'COMPLETE/PROCESSING', 'COMPLETE/VALID']);
  const stuck = { get: async () => ({ id: 'u', type: 'buildUploads', attributes: { state: { state: 'PROCESSING' } } }) };
  let t = 0;
  await assert.rejects(waitForBuild(stuck, 'u', { intervalMs: 1000, timeoutMs: 3000, sleep: async () => { t += 1000; }, now: () => t }), /Timed out.*PROCESSING/);
  const failed = await buildStatus({ get: async () => ({ id: 'u', type: 'buildUploads', attributes: { state: { state: 'FAILED', errors: [{ code: 'BAD' }] } } }) }, 'u');
  assert.equal(failed.done, true); assert.equal(failed.ok, false); assert.deepEqual(failed.problems, [{ code: 'BAD' }]);
  await assert.rejects(buildStatus(stuck, '../x'), /Invalid/);
});
test('multi-group distribution reports each group and continues after a failure', async () => {
  const api = {
    get: async (path: string) => ({ id: path.endsWith('/app') ? '123' : 'x', type: 't', attributes: path.includes('/builds/') ? { processingState: 'VALID', expired: false } : { isInternalGroup: true } }),
    list: async (path: string) => { if (path.includes('bad')) throw new Error('boom'); return { data: path.includes('done') ? [{ id: 'b', type: 'builds', attributes: {} }] : [], truncated: false }; },
    request: async () => ({}),
  };
  const result = await distributeToGroups({ account, appId: '123', buildId: 'b', groupIds: ['new', 'bad', 'done'] }, api);
  assert.equal(result.ok, false);
  assert.deepEqual(result.groups.map(g => g.status), ['submitted', 'failed', 'already_assigned']);
  await assert.rejects(distributeToGroups({ account, appId: '123', buildId: 'b', groupIds: ['a', 'a'] }, api), /distinct/);
});
