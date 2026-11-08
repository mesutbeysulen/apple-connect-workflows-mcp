import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadAsset, resumeAsset, orderPlacements, type AssetAPI } from '../src/asset-library.js';
import { createScreenshotSet, orderScreenshots, type ScreenshotSetAPI } from '../src/screenshot-sets.js';
import { cleanupStaleAssets } from '../src/asset-cleanup.js';
import { PlanStore } from '../src/plans.js';
import { AppleError, type Resource } from '../src/apple.js';
import { accountIdentity, type Account } from '../src/config.js';
import { assertContract } from './helpers.js';

const account: Account = { name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] };
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('example')]);
const res = (id: string, type: string, attributes: Record<string, unknown> = {}, relationships?: Resource['relationships']): Resource => ({ id, type, attributes, ...(relationships ? { relationships } : {}) });
type Call = { method: string; path: string; body?: unknown };

/** In-memory Apple double for one app, version, localization and asset library. */
function fakeApple(options: { imageState?: string; failPlacement?: number } = {}) {
  const calls: Call[] = [];
  const images = new Map<string, Resource>();
  let placements: { id: string; image: string; group: string; type: string }[] = [];
  let failPlacement = options.failPlacement ?? 0;
  let nextImage = 0;
  const uploadOperations = [{ method: 'PUT', url: 'https://store-1.blobstore.apple.com/up?sig=x', offset: 0, length: png.length, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] }];
  const api: AssetAPI & ScreenshotSetAPI = {
    get: async path => {
      assertContract('GET', path);
      calls.push({ method: 'GET', path });
      if (path === '/v1/appStoreVersions/version?include=app') return res('version', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION' }, { app: { data: { id: '123', type: 'apps' } } });
      if (path === '/v1/apps/123/assetLibrary') return res('lib-1', 'appAssetLibraries');
      const image = images.get(path.split('/').at(-1)!);
      if (path.startsWith('/v1/appAssetLibraryImages/') && image) return image;
      throw new AppleError(404, []);
    },
    list: async path => {
      assertContract('GET', path);
      calls.push({ method: 'LIST', path });
      if (path.includes('/appStoreVersionLocalizations?')) return { data: [res('loc', 'appStoreVersionLocalizations')], truncated: false };
      if (path.includes('/appScreenshotSets?')) return { data: [res('set-1', 'appScreenshotSets', { screenshotDisplayType: 'APP_IPHONE_65' })], truncated: false };
      const url = new URL(path, 'https://x');
      if (path.startsWith('/v1/appStoreVersionLocalizations/loc/placements')) {
        const image = url.searchParams.get('filter[image]'); const group = url.searchParams.get('filter[placementGroup]');
        return { data: placements.filter(p => (!image || p.image === image) && (!group || p.group === group)).map(p => res(p.id, 'appAssetLibraryPlacements', { placementType: p.type, placementGroup: p.group })), truncated: false };
      }
      const imagePlacements = path.match(/^\/v1\/appAssetLibraryImages\/([^/]+)\/placements/);
      if (imagePlacements) return { data: placements.filter(p => p.image === imagePlacements[1]).map(p => res(p.id, 'appAssetLibraryPlacements')), truncated: false };
      if (path.startsWith('/v1/appAssetLibraries/lib-1/images')) {
        const states = url.searchParams.get('filter[state]')?.split(',');
        return { data: [...images.values()].filter(i => !states || states.includes(String(i.attributes.state))), truncated: false };
      }
      if (path.startsWith('/v1/appAssetLibraries/lib-1/videos')) return { data: [], truncated: false };
      throw new Error(`unexpected list ${path}`);
    },
    post: async (path, body) => {
      assertContract('POST', path, body);
      calls.push({ method: 'POST', path, body });
      const data = (body as { data: { attributes: Record<string, unknown>; relationships: Record<string, { data: unknown }> } }).data;
      if (path === '/v1/appAssetLibraryImages') {
        const id = `img-${++nextImage}`;
        const image = res(id, 'appAssetLibraryImages', { ...data.attributes, state: options.imageState ?? 'AWAITING_UPLOAD', uploadOperations, createdDate: new Date().toISOString() });
        images.set(id, image); return image;
      }
      if (path === '/v1/appAssetLibraryPlacements') {
        const imageId = (data.relationships.image!.data as { id: string }).id;
        const id = `pl-${placements.length + 1}`;
        placements.push({ id, image: imageId, group: String(data.attributes.placementGroup), type: String(data.attributes.placementType) });
        if (failPlacement-- > 0) throw new Error('socket hang up');
        return res(id, 'appAssetLibraryPlacements');
      }
      if (path === '/v1/appAssetLibraryPlacementOrderingRequests') {
        const order = (data.relationships.orderedPlacements!.data as { id: string }[]).map(x => x.id);
        placements = order.map(id => placements.find(p => p.id === id)!);
        return res('ord', 'appAssetLibraryPlacementOrderingRequests');
      }
      if (path === '/v1/appScreenshotSets') return res('set-new', 'appScreenshotSets', data.attributes);
      throw new Error(`unexpected post ${path}`);
    },
    patch: async (path, type, id, attrs) => {
      assertContract('PATCH', path, { data: { type, id, attributes: attrs } });
      calls.push({ method: 'PATCH', path, body: attrs });
      const image = images.get(id)!;
      images.set(id, { ...image, attributes: { ...image.attributes, state: 'UPLOAD_COMPLETE', uploadOperations: undefined } });
      return {};
    },
    delete: async path => { assertContract('DELETE', path); calls.push({ method: 'DELETE', path }); images.delete(path.split('/').at(-1)!); },
    request: async (method, path, body) => { assertContract(method, path, body); calls.push({ method, path, body }); return {}; },
  };
  const puts: Buffer[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).has('authorization'), false);
    puts.push(Buffer.from(init.body as Uint8Array));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { api, calls, images, puts, fetcher, placements: () => placements, setPlacements: (p: typeof placements) => { placements = p; } };
}
function imageFile() {
  const dir = mkdtempSync(join(tmpdir(), 'asset-')); const filePath = join(dir, 'shot.png'); writeFileSync(filePath, png);
  return { dir, filePath };
}
const base = { account, appId: '123', versionId: 'version', localizationId: 'loc', placementGroup: 'IPHONE_DUO' };

test('asset upload reserves in the library, transfers bytes, commits and places on the localization', async () => {
  const f = fakeApple(); const { dir, filePath } = imageFile();
  try {
    const result = await uploadAsset({ ...base, filePath, referenceName: 'Hero' }, f.api, f.fetcher);
    assert.deepEqual(result, { imageId: 'img-1', imageState: 'UPLOAD_COMPLETE', placementId: 'pl-1' });
    assert.deepEqual(f.puts, [png]);
    const reserve = f.calls.find(c => c.path === '/v1/appAssetLibraryImages')!.body as any;
    assert.equal(reserve.data.attributes.category, 'APP_SCREENSHOTS_AND_PREVIEWS');
    assert.equal(reserve.data.relationships.assetLibrary.data.id, 'lib-1');
    assert.deepEqual(f.calls.find(c => c.method === 'PATCH')!.body, { uploaded: true });
    assert.deepEqual(f.placements(), [{ id: 'pl-1', image: 'img-1', group: 'IPHONE_DUO', type: 'APP_SCREENSHOT' }]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('asset upload rejects read-only account and bad placement type before any Apple call', async () => {
  const f = fakeApple(); const { dir, filePath } = imageFile();
  try {
    await assert.rejects(uploadAsset({ ...base, account: { ...account, readOnly: true }, filePath }, f.api, f.fetcher), /read-only/);
    await assert.rejects(uploadAsset({ ...base, filePath, placementType: 'APP_PREVIEW' as never }, f.api, f.fetcher), /placement type/);
    await assert.rejects(uploadAsset({ ...base, filePath, placementGroup: '../x' }, f.api, f.fetcher), /placement group/);
    assert.equal(f.calls.length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test('interrupted placement is resumed without a second reservation or duplicate placement', async () => {
  const f = fakeApple({ failPlacement: 1 }); const { dir, filePath } = imageFile();
  const dbPath = join(dir, 'jobs.sqlite');
  let store = new PlanStore(dbPath);
  try {
    // Apple created the placement but the response was lost.
    await assert.rejects(uploadAsset({ ...base, filePath }, f.api, f.fetcher, store), /Asset job: img-1/);
    assert.equal(store.asset('img-1').status, 'needs_reconciliation');
    store.close(); store = new PlanStore(dbPath);
    const result = await resumeAsset('img-1', account, store, f.api, f.fetcher);
    assert.equal(result.placementId, 'pl-1');
    assert.equal(f.calls.filter(c => c.path === '/v1/appAssetLibraryImages').length, 1);
    assert.equal(f.placements().length, 1);
    assert.equal(store.asset('img-1').status, 'placed');
    assert.equal(store.asset('img-1').placementId, 'pl-1');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('resume refuses changed source bytes and failed images', async () => {
  const f = fakeApple(); const { dir, filePath } = imageFile();
  const store = new PlanStore(':memory:');
  try {
    store.saveAsset({ id: 'img-9', account: 'team', identity: accountIdentity(account), appId: '123', versionId: 'version', localizationId: 'loc',
      placementType: 'APP_SCREENSHOT', placementGroup: 'G', filePath, sha256: 'old', createdAt: 0, placementId: null, status: 'reserved', error: null });
    await assert.rejects(resumeAsset('img-9', account, store, f.api, f.fetcher), /Source image changed/);
    assert.equal(f.calls.length, 0);
    const failing = fakeApple({ imageState: 'FAILED' });
    await assert.rejects(uploadAsset({ ...base, filePath }, failing.api, failing.fetcher, store), /state FAILED/);
    assert.equal(failing.puts.length, 0);
    assert.equal(store.asset('img-1').status, 'needs_reconciliation');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('placement order requires an exact permutation, skips no-ops and verifies the result', async () => {
  const f = fakeApple();
  f.setPlacements([{ id: 'a', image: 'i1', group: 'G', type: 'APP_SCREENSHOT' }, { id: 'b', image: 'i2', group: 'G', type: 'APP_SCREENSHOT' }, { id: 'c', image: 'i3', group: 'G', type: 'APP_SCREENSHOT' }]);
  const input = { account, appId: '123', versionId: 'version', localizationId: 'loc', placementGroup: 'G' };
  await assert.rejects(orderPlacements({ ...input, placementIds: ['a', 'b'] }, f.api), /every current placement/);
  await assert.rejects(orderPlacements({ ...input, placementIds: ['a', 'a', 'b'] }, f.api), /Duplicate/);
  assert.deepEqual(await orderPlacements({ ...input, placementIds: ['a', 'b', 'c'] }, f.api), { status: 'unchanged', order: ['a', 'b', 'c'] });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.deepEqual(await orderPlacements({ ...input, placementIds: ['c', 'a', 'b'] }, f.api), { status: 'reordered', order: ['c', 'a', 'b'] });
  const request = f.calls.find(c => c.path === '/v1/appAssetLibraryPlacementOrderingRequests')!.body as any;
  assert.equal(request.data.attributes.placementGroup, 'G');
  assert.equal(request.data.relationships.appStoreVersionLocalization.data.id, 'loc');
});

test('screenshot set creation is idempotent per display type', async () => {
  const f = fakeApple();
  const input = { account, appId: '123', versionId: 'version', localizationId: 'loc' };
  assert.deepEqual(await createScreenshotSet({ ...input, displayType: 'APP_IPHONE_65' }, f.api), { status: 'exists', setId: 'set-1', displayType: 'APP_IPHONE_65' });
  assert.deepEqual(await createScreenshotSet({ ...input, displayType: 'APP_IPHONE_67' }, f.api), { status: 'created', setId: 'set-new', displayType: 'APP_IPHONE_67' });
  await assert.rejects(createScreenshotSet({ ...input, displayType: 'iphone' }, f.api), /display type/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('legacy screenshot order replaces the set relationship and verifies it', async () => {
  let order = ['s1', 's2'];
  const f = fakeApple();
  const api: ScreenshotSetAPI = { ...f.api,
    list: async (path, limit) => path.includes('/relationships/appScreenshots') ? { data: order.map(id => res(id, 'appScreenshots')), truncated: false } : f.api.list(path, limit),
    request: async (method, path, body) => { f.calls.push({ method, path, body }); order = (body as { data: { id: string }[] }).data.map(x => x.id); return {}; },
  };
  const result = await orderScreenshots({ account, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', screenshotIds: ['s2', 's1'] }, api);
  assert.deepEqual(result, { status: 'reordered', order: ['s2', 's1'] });
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH')!.body, { data: [{ type: 'appScreenshots', id: 's2' }, { type: 'appScreenshots', id: 's1' }] });
});

test('cleanup is a dry run by default, skips recent or placed images and re-checks before delete', async () => {
  const f = fakeApple();
  const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
  f.images.set('stale', res('stale', 'appAssetLibraryImages', { state: 'AWAITING_UPLOAD', createdDate: old, fileName: 'a.png' }));
  f.images.set('failed', res('failed', 'appAssetLibraryImages', { state: 'FAILED', createdDate: old }));
  f.images.set('fresh', res('fresh', 'appAssetLibraryImages', { state: 'AWAITING_UPLOAD', createdDate: new Date().toISOString() }));
  f.images.set('placed', res('placed', 'appAssetLibraryImages', { state: 'FAILED', createdDate: old }));
  f.images.set('done', res('done', 'appAssetLibraryImages', { state: 'COMPLETE', createdDate: old }));
  f.setPlacements([{ id: 'p', image: 'placed', group: 'G', type: 'APP_SCREENSHOT' }]);
  const preview = await cleanupStaleAssets({ account: { ...account, readOnly: true }, appId: '123' }, f.api);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.candidates.map(c => c.id).sort(), ['failed', 'stale']);
  assert.deepEqual(preview.skipped.map(s => s.id), ['placed']);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  await assert.rejects(cleanupStaleAssets({ account: { ...account, readOnly: true }, appId: '123', execute: true }, f.api), /read-only/);
  // State changes between listing and delete must be respected.
  const api: AssetAPI = { ...f.api, get: async path => path.endsWith('/failed') ? res('failed', 'appAssetLibraryImages', { state: 'UPLOAD_COMPLETE' }) : f.api.get(path) };
  const run = await cleanupStaleAssets({ account, appId: '123', execute: true }, api);
  assert.deepEqual(run.deleted, ['stale']);
  assert.match(run.skipped.find(s => s.id === 'failed')!.reason, /State changed/);
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/v1/appAssetLibraryImages/stale']);
});

test('cleanup archives what Apple refuses to delete and keeps journals in step', async () => {
  const f = fakeApple();
  const store = new PlanStore(':memory:');
  const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
  f.images.set('stuck', res('stuck', 'appAssetLibraryImages', { state: 'AWAITING_UPLOAD', createdDate: old }));
  store.saveCreative({ id: 'stuck', kind: 'image', account: 'team', identity: accountIdentity(account), appId: '123', filePath: '/x.png', sha256: 'h', size: 1, createdAt: 0, status: 'needs_reconciliation', error: null });
  const api: AssetAPI = { ...f.api, delete: async () => { throw new AppleError(409, []); }, patch: async (path, _t, _i, attrs) => { f.calls.push({ method: 'PATCH', path, body: attrs }); return {}; } };
  try {
    const run = await cleanupStaleAssets({ account, appId: '123', execute: true }, api, store);
    assert.deepEqual(run.archived, ['stuck']); assert.deepEqual(run.deleted, []);
    assert.deepEqual(f.calls.at(-1)!.body, { archived: true });
    assert.equal(store.creative('stuck').status, 'archived');
    await assert.rejects((await import('../src/creative-assets.js')).resumeCreative('stuck', account, store, api), /archived by asset-cleanup/);
  } finally { store.close(); }
});
test('cleanup preview leaves the local journal untouched', async () => {
  const f = fakeApple();
  const store = new PlanStore(':memory:');
  store.saveScreenshot({ account: 'team', identity: accountIdentity(account), appId: '123', versionId: 'v', localizationId: 'l', setId: 's', filePath: '/x.png', sha256: 'h', error: null, id: 'gone-remote', createdAt: Date.now() - 48 * 3_600_000, status: 'reserved' });
  const api: AssetAPI = { ...f.api, get: async path => { if (path.startsWith('/v1/appScreenshots/')) throw new AppleError(404, []); return f.api.get(path); } };
  try {
    const preview = await cleanupStaleAssets({ account, appId: '123' }, api, store);
    assert.equal(store.screenshot('gone-remote').status, 'reserved');
    assert(preview.skipped.some(s => s.id === 'gone-remote'));
    await cleanupStaleAssets({ account, appId: '123', execute: true }, api, store);
    assert.equal(store.screenshot('gone-remote').status, 'gone');
  } finally { store.close(); }
});
test('asset library lookup explains a missing library', async () => {
  const { assetLibraryId } = await import('../src/asset-library.js');
  await assert.rejects(assetLibraryId({ get: async () => null as never }, '123'), /no asset library/);
});
test('cleanup includes only journaled legacy screenshots that are stale and old', async () => {
  const f = fakeApple();
  const store = new PlanStore(':memory:');
  const identity = accountIdentity(account);
  const job = { account: 'team', identity, appId: '123', versionId: 'version', localizationId: 'loc', setId: 'set-1', filePath: '/x.png', sha256: 'h', error: null };
  store.saveScreenshot({ ...job, id: 'legacy-old', createdAt: Date.now() - 48 * 3_600_000, status: 'needs_reconciliation' });
  store.saveScreenshot({ ...job, id: 'legacy-new', createdAt: Date.now(), status: 'reserved' });
  store.saveScreenshot({ ...job, id: 'legacy-undated', status: 'reserved' });
  const api: AssetAPI = { ...f.api, get: async path => path.startsWith('/v1/appScreenshots/') ? res(path.split('/').at(-1)!, 'appScreenshots', { assetDeliveryState: { state: 'AWAITING_UPLOAD' } }) : f.api.get(path) };
  try {
    const run = await cleanupStaleAssets({ account, appId: '123', execute: true }, api, store);
    assert.deepEqual(run.deleted, ['legacy-old']);
    assert.equal(store.screenshot('legacy-old').status, 'deleted');
    assert(run.skipped.some(s => s.id === 'legacy-undated'));
    assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/v1/appScreenshots/legacy-old']);
  } finally { store.close(); }
});
