import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadCreative, resumeCreative, submitCreatives, placeCreative, removeCreativePlacement, imageInfo, parseTargets, creativeOverview } from '../src/creative-assets.js';
import { PlanStore } from '../src/plans.js';
import { AppleError } from '../src/apple.js';
import { account, readOnly, res, fakeApi, png } from './helpers.js';

const specs = [res('ref', 'appAssetLibraryRefData', { imageSpecs: [
  { specId: 'HEADER', compatiblePlacementTypes: ['PRODUCT_PAGE_HEADER_ASSET'], dimensions: { minWidth: 3840, maxWidth: 3840, minHeight: 1646, maxHeight: 1646 }, alphaAllowed: false, fileExtensions: ['png', 'jpg'] },
  { specId: 'SEARCH', compatiblePlacementTypes: ['APP_STORE_SEARCH_RESULTS_ASSET'], dimensions: { minWidth: 1920, maxWidth: 3840, minHeight: 1280, maxHeight: 2560 }, alphaAllowed: false, fileExtensions: ['png', 'jpg'] },
] })];
const ops = (size: number) => [{ method: 'PUT', url: 'https://store-1.blobstore.apple.com/x', offset: 0, length: size, requestHeaders: [] }];
function fixture(bytes: Buffer, name = 'a.png', extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'creative-')); const filePath = join(dir, name); writeFileSync(filePath, bytes);
  const f = fakeApi({ '/v1/appAssetLibraryRefData': specs, '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'),
    '/v1/appAssetLibraryImages/img': res('img', 'appAssetLibraryImages', { state: 'PREPARE_FOR_SUBMISSION' }), ...extra },
    { post: (path, body) => path === '/v1/appAssetLibraryImages' ? res('img', 'appAssetLibraryImages', { ...body.data.attributes, state: 'AWAITING_UPLOAD', uploadOperations: ops(bytes.length) }) : res('new', body.data.type) });
  const sent: Buffer[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).has('authorization'), false);
    const pieces: Buffer[] = []; for await (const p of init.body as unknown as AsyncIterable<Buffer>) pieces.push(p);
    sent.push(Buffer.concat(pieces)); return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { dir, filePath, ...f, sent, fetcher };
}
test('reads PNG size and alpha, and JPEG size', () => {
  assert.deepEqual(imageInfo(png(3840, 1646)), { width: 3840, height: 1646, hasAlpha: false });
  assert.equal(imageInfo(png(10, 10, 6)).hasAlpha, true);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x04,0,0,0xff,0xc0,0x00,0x11,0x08,0x06,0x6e,0x0f,0x00,0x03,0,0,0,0,0,0]);
  assert.deepEqual(imageInfo(jpeg), { width: 3840, height: 1646, hasAlpha: false });
  assert.deepEqual(parseTargets('header,search,header'), ['header', 'search']);
  assert.throws(() => parseTargets('hero'), /header, search/);
});
test('uploads a header image as CREATIVE_ASSETS without placing or submitting it', async () => {
  const bytes = png(3840, 1646); const f = fixture(bytes);
  try {
    const result = await uploadCreative({ account, appId: '123', targets: ['header'], filePath: f.filePath }, f.api, f.fetcher);
    assert.equal(result.state, 'PREPARE_FOR_SUBMISSION'); assert.equal(result.specCheck, 'passed');
    assert.deepEqual(f.sent, [bytes]);
    const reserve = f.calls.find(c => c.path === '/v1/appAssetLibraryImages')!.body as any;
    assert.equal(reserve.data.attributes.category, 'CREATIVE_ASSETS');
    assert.equal(reserve.data.attributes.specId, undefined);
    assert.equal(f.calls.some(c => /Placements|reviewSub/.test(c.path) && c.method === 'POST'), false);
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('wrong pixel size or alpha fails before any reservation', async () => {
  const f = fixture(png(1000, 1000));
  try {
    await assert.rejects(uploadCreative({ account, appId: '123', targets: ['header'], filePath: f.filePath }, f.api, f.fetcher), /does not fit header.*HEADER/);
    writeFileSync(f.filePath, png(3840, 1646, 6));
    await assert.rejects(uploadCreative({ account, appId: '123', targets: ['header'], filePath: f.filePath }, f.api, f.fetcher), /with alpha/);
    // A universal request must satisfy both placements.
    writeFileSync(f.filePath, png(1920, 1280));
    await assert.rejects(uploadCreative({ account, appId: '123', targets: ['header', 'search'], filePath: f.filePath }, f.api, f.fetcher), /does not fit header/);
    await assert.rejects(uploadCreative({ account: readOnly, appId: '123', targets: ['search'], filePath: f.filePath }, f.api, f.fetcher), /read-only/);
    assert.equal(f.writes().length, 0);
  } finally { rmSync(f.dir, { recursive: true }); }
});
test('video upload streams to the video resource', async () => {
  const bytes = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypqt  '), Buffer.alloc(40)]);
  const dir = mkdtempSync(join(tmpdir(), 'creative-')); const filePath = join(dir, 'a.mov'); writeFileSync(filePath, bytes);
  const f = fakeApi({ '/v1/appAssetLibraryRefData': [], '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'), '/v1/appAssetLibraryVideos/vid': res('vid', 'appAssetLibraryVideos', { state: 'UPLOAD_COMPLETE' }) },
    { post: () => res('vid', 'appAssetLibraryVideos', { state: 'AWAITING_UPLOAD', uploadOperations: ops(bytes.length) }) });
  const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null, { status: 200 }); }) as typeof fetch;
  try {
    const result = await uploadCreative({ account, appId: '123', targets: ['header'], filePath, previewFrameTimeCode: '00:00:02:00' }, f.api, fetcher);
    assert.equal(result.kind, 'video'); assert.equal(result.specCheck, 'apple_validates');
    assert.equal((f.calls.find(c => c.path === '/v1/appAssetLibraryVideos')!.body as any).data.attributes.previewFrameTimeCode, '00:00:02:00');
    writeFileSync(filePath, 'not a movie at all');
    await assert.rejects(uploadCreative({ account, appId: '123', targets: ['header'], filePath }, f.api, fetcher), /ftyp/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('interrupted upload resumes without another reservation and refuses changed files', async () => {
  const bytes = png(3840, 1646); let awaiting = true;
  const f = fixture(bytes, 'a.png', { '/v1/appAssetLibraryImages/img': () => res('img', 'appAssetLibraryImages', awaiting ? { state: 'AWAITING_UPLOAD', uploadOperations: ops(bytes.length) } : { state: 'UPLOAD_COMPLETE' }) });
  const api = { ...f.api, patch: async (p: string, t: string, i: string, a: Record<string, unknown>) => { awaiting = false; return f.api.patch(p, t, i, a); } };
  const store = new PlanStore(':memory:'); let fail = true;
  const fetcher = (async (u: string, init: RequestInit) => { if (fail) { fail = false; return new Response(null, { status: 500 }); } return f.fetcher(u, init); }) as typeof fetch;
  try {
    await assert.rejects(uploadCreative({ account, appId: '123', targets: ['header'], filePath: f.filePath }, api, fetcher, store), /Creative job: img/);
    assert.equal(store.creative('img').status, 'needs_reconciliation');
    const result = await resumeCreative('img', account, store, api, fetcher);
    assert.equal(result.state, 'UPLOAD_COMPLETE');
    assert.equal(f.calls.filter(c => c.path === '/v1/appAssetLibraryImages').length, 1);
    writeFileSync(f.filePath, png(3840, 1647));
    await assert.rejects(resumeCreative('img', account, store, api, fetcher), /Source file changed/);
  } finally { store.close(); rmSync(f.dir, { recursive: true }); }
});

const routes = (versionState: string, assetState: string, existing: unknown[] = []) => ({
  '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'),
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: versionState }, { app: { data: { id: '123', type: 'apps' } } }),
  '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'appStoreVersionLocalizations', { locale: 'tr' })],
  '/v1/appAssetLibraries/lib/images': (path: string) => new URL(path, 'https://x').searchParams.get('filter[id]') === 'img' ? [res('img', 'appAssetLibraryImages', { state: assetState })] : [],
  '/v1/appStoreVersionLocalizations/loc/placements': existing as never,
});
const place = { account, appId: '123', versionId: 'v', localizationId: 'loc', kind: 'image' as const, assetId: 'img' };
test('places one asset on both Header and Search Results', async () => {
  const f = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'PREPARE_FOR_SUBMISSION'), { post: (_p, b) => res(`pl-${b.data.attributes.placementType}`, 'appAssetLibraryPlacements') });
  const result = await placeCreative({ ...place, targets: ['header', 'search'] }, f.api);
  assert.deepEqual(f.writes().map(w => (w.body as any).data.attributes.placementType), ['PRODUCT_PAGE_HEADER_ASSET', 'APP_STORE_SEARCH_RESULTS_ASSET']);
  const body = f.writes()[0]!.body as any;
  assert.equal(body.data.relationships.image.data.id, 'img');
  assert.equal(body.data.relationships.appStoreVersionLocalization.data.id, 'loc');
  assert.equal(body.data.attributes.placementGroup, undefined);
  assert.equal(result.placements.length, 2);
});
test('placing is idempotent and never replaces without an explicit flag', async () => {
  const same = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [res('p1', 'appAssetLibraryPlacements', {}, { image: { data: { id: 'img', type: 'appAssetLibraryImages' } } })]));
  assert.equal((await placeCreative({ ...place, targets: ['header'] }, same.api)).placements[0]!.status, 'exists');
  assert.equal(same.writes().length, 0);
  const old = res('old', 'appAssetLibraryPlacements', { placementGroup: 'G1' }, { image: { data: { id: 'other', type: 'appAssetLibraryImages' } } });
  const other = () => fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [old]));
  const blocked = other();
  await assert.rejects(placeCreative({ ...place, targets: ['header'] }, blocked.api), /--replace/);
  assert.equal(blocked.writes().length, 0);
  const swap = other();
  const result = await placeCreative({ ...place, targets: ['header'], replace: true }, swap.api);
  assert.deepEqual(swap.writes().map(w => w.method), ['POST', 'DELETE']);
  assert.deepEqual(result.placements[0]!.replaced, ['old']);
});
const linkedRow = (id: string, asset: string, placementGroup = 'G1') => res(id, 'appAssetLibraryPlacements', { placementGroup }, { image: { data: { id: asset, type: 'appAssetLibraryImages' } } });
test('a group limit falls back to swap, and failure restores the previous asset', async () => {
  let posts = 0;
  const limit = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [linkedRow('old', 'other')]), { post: () => { if (++posts === 1) throw new AppleError(409, []); return res('p2', 'appAssetLibraryPlacements'); } });
  const swapped = await placeCreative({ ...place, targets: ['header'], replace: true }, limit.api);
  assert.equal(swapped.placements[0]!.placementId, 'p2');
  assert.deepEqual(limit.writes().map(w => w.method), ['POST', 'DELETE', 'POST']);
  let attempts = 0;
  const restored = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [linkedRow('old', 'other')]), { post: () => { if (++attempts <= 2) throw new AppleError(409, []); return res('back', 'appAssetLibraryPlacements'); } });
  await assert.rejects(placeCreative({ ...place, targets: ['header'], replace: true }, restored.api), /Previous assets were restored/);
  assert.equal((restored.writes().at(-1)!.body as any).data.relationships.image.data.id, 'other');
  assert.equal((restored.writes().at(-1)!.body as any).data.attributes.placementGroup, 'G1');
  const lost = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [linkedRow('old', 'other')]), { post: () => { throw new AppleError(409, []); } });
  await assert.rejects(placeCreative({ ...place, targets: ['header'], replace: true }, lost.api), /place them again: image other/);
});
test('an uncertain placement failure never removes the live asset', async () => {
  const f = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [linkedRow('old', 'other')]), { post: () => { throw new Error('socket hang up'); } });
  await assert.rejects(placeCreative({ ...place, targets: ['header'], replace: true }, f.api), /socket hang up/);
  assert.equal(f.writes().some(w => w.method === 'DELETE'), false);
});
test('replace refuses unidentified assets and needs a group when several variants exist', async () => {
  const unknown = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [res('old', 'appAssetLibraryPlacements')]));
  await assert.rejects(placeCreative({ ...place, targets: ['header'], replace: true }, unknown.api), /Could not identify/);
  const many = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [linkedRow('a', 'x', 'IPHONE'), linkedRow('b', 'y', 'IPAD')]));
  await assert.rejects(placeCreative({ ...place, targets: ['header'], replace: true }, many.api), /2 placements across groups \(IPHONE, IPAD\)/);
  assert.equal(unknown.writes().length + many.writes().length, 0);
});
test('approved versions accept only approved assets; foreign and failed assets are refused', async () => {
  const live = fakeApi(routes('READY_FOR_SALE', 'PREPARE_FOR_SUBMISSION'));
  await assert.rejects(placeCreative({ ...place, targets: ['header'] }, live.api), /accepts only APPROVED/);
  const approved = fakeApi(routes('READY_FOR_SALE', 'APPROVED'), { post: () => res('p', 'appAssetLibraryPlacements') });
  assert.equal((await placeCreative({ ...place, targets: ['search'] }, approved.api)).placements[0]!.status, 'created');
  const failed = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'FAILED'));
  await assert.rejects(placeCreative({ ...place, targets: ['header'] }, failed.api), /state FAILED/);
  const foreign = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED'));
  await assert.rejects(placeCreative({ ...place, assetId: 'stranger', targets: ['header'] }, foreign.api), /not in this app/);
  assert.equal(foreign.writes().length + failed.writes().length + live.writes().length, 0);
});
test('standalone creative review submits exactly the requested asset', async () => {
  const f = fakeApi({ ...routes('READY_FOR_SALE', 'PREPARE_FOR_SUBMISSION'), '/v1/reviewSubmissions/new-id': res('new-id', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }) });
  const result = await submitCreatives({ account, appId: '123', imageIds: ['img'] }, f.api);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(f.writes().map(w => w.path), ['/v1/reviewSubmissions', '/v1/reviewSubmissionItems', '/v1/reviewSubmissions/new-id']);
  assert.equal((f.writes()[1]!.body as any).data.relationships.appAssetLibraryImage.data.id, 'img');
  assert.deepEqual(f.writes()[2]!.body, { submitted: true });
  const dup = fakeApi({ ...routes('READY_FOR_SALE', 'PREPARE_FOR_SUBMISSION'), '/v1/reviewSubmissions/new-id': res('new-id', 'reviewSubmissions', {}) });
  await submitCreatives({ account, appId: '123', imageIds: ['img', 'img'] }, dup.api);
  assert.equal(dup.writes().filter(w => w.path === '/v1/reviewSubmissionItems').length, 1);
  const rejected = fakeApi(routes('READY_FOR_SALE', 'REJECTED'));
  await assert.rejects(submitCreatives({ account, appId: '123', imageIds: ['img'] }, rejected.api), /cannot be submitted/);
});
test('removing a placement checks it is a creative placement on this localization', async () => {
  const input = { account, appId: '123', versionId: 'v', localizationId: 'loc', placementId: 'p1' };
  const ok = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [res('p1', 'appAssetLibraryPlacements', { placementType: 'PRODUCT_PAGE_HEADER_ASSET' })]));
  assert.deepEqual(await removeCreativePlacement(input, ok.api), { removed: 'p1' });
  const shot = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED', [res('p1', 'appAssetLibraryPlacements', { placementType: 'APP_SCREENSHOT' })]));
  await assert.rejects(removeCreativePlacement(input, shot.api), /Not a Header/);
  const none = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED'));
  await assert.rejects(removeCreativePlacement(input, none.api), /not on this localization/);
  assert.equal(shot.writes().length + none.writes().length, 0);
});
test('overview lists both placements per locale', async () => {
  const f = fakeApi(routes('PREPARE_FOR_SUBMISSION', 'APPROVED'));
  const view = await creativeOverview(f.api, 'v');
  assert.deepEqual(Object.keys(view.localizations[0]!), ['localizationId', 'locale', 'header', 'search']);
});
