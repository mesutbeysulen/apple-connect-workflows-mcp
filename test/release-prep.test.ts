import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prep from '../src/release-prep.js';
import { placePreview, uploadPreview } from '../src/creative-assets.js';
import { readMetadataFile, scanScreenshots, syncMetadata, syncScreenshots } from '../src/bulk.js';
import { applyApiPlan, createApiPlan } from '../src/api-plans.js';
import { checkSchema, requestSchema } from '../src/schema-check.js';
import { uploadBuild, resumeBuild } from '../src/build-upload.js';
import { createTokenProvider, AppleError } from '../src/apple.js';
import { configSchema } from '../src/config.js';
import { generateKeyPairSync } from 'node:crypto';
import { PlanStore } from '../src/plans.js';
import { account, readOnly, res, fakeApi, png, withContract } from './helpers.js';

const owned = { app: { data: { id: '123', type: 'apps' } } };
const base = (extra: Record<string, unknown> = {}) => ({
  '/v1/apps/123': res('123', 'apps', { primaryLocale: 'en-US' }),
  '/v1/apps/123/appInfos': [res('i', 'appInfos', { state: 'PREPARE_FOR_SUBMISSION' })],
  '/v1/appInfos/i/appInfoLocalizations': [res('il', 'appInfoLocalizations', { locale: 'en-US', name: 'App' })],
  '/v1/appInfos/i/ageRatingDeclaration': res('age', 'ageRatingDeclarations'),
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION', copyright: 'old' }, owned),
  '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('vl', 'appStoreVersionLocalizations', { locale: 'en-US', description: 'old', keywords: 'k' })],
  '/v1/builds/b/app': res('123', 'apps'),
  '/v1/builds/b': res('b', 'builds', { processingState: 'VALID', expired: false }),
  '/v1/betaGroups/g/app': res('123', 'apps'),
  ...extra,
}) as never;
const write = { account, appId: '123' };

test('app information creates a new language, updates changed fields only and validates limits', async () => {
  const f = fakeApi(base());
  assert.equal((await prep.setAppInfo({ ...write, locale: 'tr', name: 'Uygulama', privacyPolicyUrl: 'https://x.example/p' }, f.api)).status, 'created');
  assert.equal((f.writes()[0]!.body as any).data.relationships.appInfo.data.id, 'i');
  assert.equal((await prep.setAppInfo({ ...write, locale: 'en-US', name: 'App' }, f.api)).status, 'unchanged');
  assert.deepEqual((await prep.setAppInfo({ ...write, locale: 'en-US', name: 'App', subtitle: 'Sub' }, f.api)).changed, ['subtitle']);
  await assert.rejects(prep.setAppInfo({ ...write, locale: 'de', subtitle: 'x' }, f.api), /--name is required/);
  await assert.rejects(prep.setAppInfo({ ...write, locale: 'tr', name: 'x'.repeat(31) }, f.api), /30 characters/);
  await assert.rejects(prep.setAppInfo({ ...write, locale: 'tr', name: 'A', privacyPolicyUrl: 'not a url' }, f.api), /full web address/);
  await assert.rejects(prep.setAppInfo({ account: readOnly, appId: '123', locale: 'tr', name: 'A' }, f.api), /read-only/);
  const locked = fakeApi(base({ '/v1/apps/123/appInfos': [res('i', 'appInfos', { state: 'READY_FOR_DISTRIBUTION' })] }));
  await assert.rejects(prep.setAppInfo({ ...write, locale: 'tr', name: 'A' }, locked.api), /no editable app information/);
});
test('categories, app fields and age rating send valid requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prep-'));
  const f = fakeApi(base());
  try {
    assert.deepEqual((await prep.setCategories({ ...write, categories: { primary: 'GAMES', primarySub1: 'GAMES_ACTION' } }, f.api)).set, ['primary', 'primarySub1']);
    assert.equal(((f.writes()[0]!.body as any).data.relationships.primaryCategory.data.id), 'GAMES');
    await assert.rejects(prep.setCategories({ ...write, categories: {} }, f.api), /--primary/);
    assert.deepEqual((await prep.updateApp({ ...write, contentRights: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' }, f.api)).changed, ['contentRightsDeclaration']);
    await assert.rejects(prep.updateApp({ ...write, contentRights: 'MAYBE' }, f.api), /--content-rights/);
    const good = join(dir, 'age.json'); writeFileSync(good, JSON.stringify({ gambling: false, contests: 'NONE' }));
    assert.deepEqual((await prep.setAgeRating({ ...write, filePath: good }, f.api)).answered, ['gambling', 'contests']);
    const before = f.writes().length;
    writeFileSync(good, JSON.stringify({ contests: 'SOMETIMES' }));
    await assert.rejects(prep.setAgeRating({ ...write, filePath: good }, f.api), /must be one of/);
    writeFileSync(good, JSON.stringify({ notAQuestion: true }));
    await assert.rejects(prep.setAgeRating({ ...write, filePath: good }, f.api), /not a known field/);
    assert.equal(f.writes().length, before);
  } finally { rmSync(dir, { recursive: true }); }
});
test('availability previews, then sends one inline record per territory', async () => {
  const f = fakeApi(base());
  const input = { ...write, territories: ['USA', 'TUR'], availableInNewTerritories: false };
  assert.equal((await prep.setAvailability({ ...input, account: readOnly }, f.api)).dryRun, true);
  assert.equal(f.writes().length, 0);
  await prep.setAvailability({ ...input, execute: true }, f.api);
  const body = f.writes()[0]!.body as any;
  assert.deepEqual(body.included.map((row: any) => row.relationships.territory.data.id), ['USA', 'TUR']);
  assert.deepEqual(body.data.relationships.territoryAvailabilities.data.map((row: any) => row.id), body.included.map((row: any) => row.id));
  await assert.rejects(prep.setAvailability({ ...input, territories: ['usa'] }, f.api), /three-letter/);
});
test('versions are created once, build attach is verified, and encryption is answered', async () => {
  const f = fakeApi(base({ '/v1/apps/123/appStoreVersions': [] }));
  assert.equal((await prep.createVersion({ ...write, platform: 'IOS', versionString: '1.2.3', copyright: '2026 X' }, f.api)).status, 'created');
  const exists = fakeApi(base({ '/v1/apps/123/appStoreVersions': [res('v', 'appStoreVersions', { appVersionState: 'PREPARE_FOR_SUBMISSION' })] }));
  assert.deepEqual(await prep.createVersion({ ...write, platform: 'IOS', versionString: '1.2.3' }, exists.api), { status: 'exists', versionId: 'v', state: 'PREPARE_FOR_SUBMISSION' });
  await assert.rejects(prep.createVersion({ ...write, platform: 'IOS', versionString: 'one' }, f.api), /1\.2\.3/);
  await assert.rejects(prep.createVersion({ ...write, platform: 'ANDROID', versionString: '1.0' }, f.api), /Platform/);
  await assert.rejects(prep.updateVersion({ ...write, versionId: 'v', releaseType: 'MANUAL', earliestReleaseDate: '2027-01-01T00:00:00Z' }, f.api), /SCHEDULED/);
  assert.deepEqual((await prep.updateVersion({ ...write, versionId: 'v', copyright: '2026 Y' }, f.api)).changed, ['copyright']);
  let attached = false;
  const a = fakeApi(base({ '/v1/appStoreVersions/v/build': () => attached ? res('b', 'builds') : undefined as never }));
  const api = { ...a.api, request: async (method: 'PATCH', path: string, body: unknown) => { attached = true; return a.api.request(method, path, body); } };
  assert.equal((await prep.attachBuild({ ...write, versionId: 'v', buildId: 'b' }, api)).status, 'attached');
  assert.equal((await prep.attachBuild({ ...write, versionId: 'v', buildId: 'b' }, api)).status, 'already_attached');
  const unconfirmed = fakeApi(base());
  await assert.rejects(prep.attachBuild({ ...write, versionId: 'v', buildId: 'b' }, unconfirmed.api), /not confirmed/);
  const busy = fakeApi(base({ '/v1/builds/b': res('b', 'builds', { processingState: 'PROCESSING' }) }));
  await assert.rejects(prep.attachBuild({ ...write, versionId: 'v', buildId: 'b' }, busy.api), /not ready/);
  const other = fakeApi(base({ '/v1/builds/b/app': res('999', 'apps') }));
  await assert.rejects(prep.attachBuild({ ...write, versionId: 'v', buildId: 'b' }, other.api), /does not belong/);
  const e = fakeApi(base());
  assert.deepEqual((await prep.setBuildEncryption({ ...write, buildId: 'b', usesNonExemptEncryption: false }, e.api)).changed, ['usesNonExemptEncryption']);
});
test('version languages, review contact, phased release and review draft cleanup', async () => {
  const f = fakeApi(base({ '/v1/apps/123/reviewSubmissions': [res('s', 'reviewSubmissions')], '/v1/reviewSubmissions/s/items': [res('it', 'reviewSubmissionItems')], '/v1/reviewSubmissions/s': res('s', 'reviewSubmissions', { state: 'CANCELING' }) }));
  const v = { ...write, versionId: 'v' };
  assert.equal((await prep.setVersionLocale({ ...v, locale: 'tr', description: 'Açıklama' }, f.api)).status, 'created');
  await assert.rejects(prep.setVersionLocale({ ...v, locale: 'tr', keywords: 'ş'.repeat(51) }, f.api), /100 bytes/);
  await assert.rejects(prep.setVersionLocale({ ...v, locale: '../x' }, f.api), /Invalid locale/);
  assert.equal((await prep.setReviewDetail({ ...v, contactFirstName: 'A', contactLastName: 'B', contactPhone: '+1', contactEmail: 'a@x.co', demoAccountRequired: true, demoAccountName: 'u', demoAccountPassword: 'p' }, f.api)).status, 'created');
  assert.equal((await prep.setPhasedRelease({ ...v, state: 'ACTIVE' }, f.api)).status, 'created');
  await assert.rejects(prep.setPhasedRelease({ ...v, state: 'FAST' }, f.api), /must be one of/);
  const live = fakeApi(base({ '/v1/appStoreVersions/v/appStoreVersionPhasedRelease': res('ph', 'appStoreVersionPhasedReleases', { phasedReleaseState: 'ACTIVE' }) }));
  assert.equal((await prep.setPhasedRelease({ ...v, state: 'ACTIVE' }, live.api)).status, 'unchanged');
  assert.deepEqual((await prep.setPhasedRelease({ ...v, state: 'PAUSED' }, live.api)).changed, ['phasedReleaseState']);
  assert.deepEqual(await prep.cancelSubmission({ ...write, submissionId: 's' }, f.api), { submissionId: 's', state: 'CANCELING' });
  await assert.rejects(prep.cancelSubmission({ ...write, submissionId: 'other' }, f.api), /does not belong/);
  assert.deepEqual(await prep.removeReviewItem({ ...write, submissionId: 's', itemId: 'it' }, f.api), { removed: 'it' });
  await assert.rejects(prep.removeReviewItem({ ...write, submissionId: 's', itemId: 'nope' }, f.api), /not in this submission/);
});
test('review attachment reserves, uploads with Content-Length and commits an MD5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prep-')); const filePath = join(dir, 'demo.mov'); writeFileSync(filePath, 'video-bytes');
  const f = fakeApi(base({ '/v1/appStoreVersions/v/appStoreReviewDetail': res('rd', 'appStoreReviewDetails'), '/v1/appStoreReviewAttachments/att': res('att', 'x', { assetDeliveryState: { state: 'UPLOAD_COMPLETE' } }) }),
    { post: () => res('att', 'appStoreReviewAttachments', { uploadOperations: [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: 11, requestHeaders: [] }] }) });
  const fetcher = (async (_u: string, init: RequestInit) => { assert.equal(new Headers(init.headers).get('content-length'), '11'); for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
  try {
    assert.equal((await prep.uploadReviewAttachment({ ...write, versionId: 'v', filePath }, f.api, fetcher)).attachmentId, 'att');
    assert.match(String((f.writes().at(-1)!.body as any).sourceFileChecksum), /^[0-9a-f]{32}$/);
    await assert.rejects(prep.uploadReviewAttachment({ ...write, versionId: 'v', filePath }, fakeApi(base()).api, fetcher), /review-detail-set/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('TestFlight setup: beta text, notes, review, groups and testers', async () => {
  const f = fakeApi(base({
    '/v1/apps/123/betaAppLocalizations': [], '/v1/builds/b/betaBuildLocalizations': [res('n', 'betaBuildLocalizations', { locale: 'tr', whatsNew: 'old' })],
    '/v1/apps/123/betaAppReviewDetail': res('brd', 'betaAppReviewDetails', { contactEmail: 'a@x.co' }), '/v1/apps/123/betaGroups': [res('g', 'betaGroups', { name: 'QA' })],
    '/v1/betaGroups/g/betaTesters': [res('t1', 'betaTesters', { email: 'In@x.co' })],
    '/v1/betaTesters': (path: string) => path.includes('known') ? [res('t2', 'betaTesters')] : [],
  }));
  assert.equal((await prep.setBetaAppInfo({ ...write, locale: 'tr', feedbackEmail: 'a@x.co', description: 'd' }, f.api)).status, 'created');
  assert.equal((await prep.setBetaBuildNotes({ ...write, buildId: 'b', locale: 'tr', whatsNew: 'new' }, f.api)).status, 'updated');
  assert.equal((await prep.setBetaReviewDetail({ ...write, contactEmail: 'a@x.co' }, f.api)).status, 'unchanged');
  assert.equal((await prep.submitBetaReview({ ...write, buildId: 'b' }, f.api)).status, 'submitted');
  assert.equal((await prep.createBetaGroup({ ...write, name: 'QA' }, f.api)).status, 'exists');
  assert.equal((await prep.createBetaGroup({ ...write, name: 'External', publicLink: true, feedback: true }, f.api)).status, 'created');
  const added = await prep.addBetaTesters({ ...write, groupId: 'g', testers: [{ email: 'in@x.co' }, { email: 'known@x.co' }, { email: 'new@x.co', firstName: 'N' }] }, f.api);
  assert.deepEqual(added, { groupId: 'g', added: ['known@x.co', 'new@x.co'], alreadyInGroup: ['in@x.co'] });
  assert(f.writes().some(w => w.path === '/v1/betaGroups/g/relationships/betaTesters'));
  await assert.rejects(prep.addBetaTesters({ ...write, groupId: 'g', testers: [{ email: 'bad' }] }, f.api), /Invalid tester email/);
  assert.deepEqual(await prep.removeBetaTester({ ...write, groupId: 'g', testerId: 't1' }, f.api), { removed: 't1' });
  const foreign = fakeApi(base({ '/v1/betaGroups/g/app': res('999', 'apps') }));
  await assert.rejects(prep.removeBetaTester({ ...write, groupId: 'g', testerId: 't1' }, foreign.api), /does not belong/);
  const sent = fakeApi(base({ '/v1/builds/b/betaAppReviewSubmission': res('br', 'betaAppReviewSubmissions', { betaReviewState: 'IN_REVIEW' }) }));
  assert.deepEqual(await prep.submitBetaReview({ ...write, buildId: 'b' }, sent.api), { status: 'already_submitted', id: 'br', state: 'IN_REVIEW' });
  assert.equal(sent.writes().length, 0);
});
test('bundle IDs and review replies', async () => {
  const f = fakeApi({ '/v1/bundleIds': [res('b1', 'bundleIds', { identifier: 'com.x.a' })], '/v1/apps/123/customerReviews': [res('r1', 'customerReviews')] });
  assert.equal((await prep.createBundleId({ account, identifier: 'com.x.a', name: 'A', platform: 'IOS' }, f.api)).status, 'exists');
  assert.equal((await prep.createBundleId({ account: { ...account, allowedAppIds: [] }, identifier: 'com.x.b', name: 'B', platform: 'IOS' }, f.api)).status, 'created');
  await assert.rejects(prep.createBundleId({ account: readOnly, identifier: 'com.x.c', name: 'C', platform: 'IOS' }, f.api), /read-only/);
  assert.equal((await prep.replyToReview({ ...write, reviewId: 'r1', text: 'Teşekkürler' }, f.api)).responseId, 'new-id');
  await assert.rejects(prep.replyToReview({ ...write, reviewId: 'nope', text: 'x' }, f.api), /not found/);
  await assert.rejects(prep.replyToReview({ ...write, reviewId: 'r1', text: ' ' }, f.api), /1-5970/);
});
test('metadata sync previews a diff, applies only differences and validates everything first', async () => {
  const f = fakeApi(base());
  const metadata = { locales: {
    'en-US': { name: 'App', description: 'new', keywords: 'k' },
    tr: { name: 'Uygulama', subtitle: 'Alt', privacyPolicyUrl: 'https://x.example/p', description: 'Açıklama', keywords: 'a,b', supportUrl: 'https://x.example/s' },
  } };
  const preview = await syncMetadata({ account: readOnly, appId: '123', versionId: 'v', metadata }, f.api);
  assert.equal(preview.dryRun, true); assert.equal(f.writes().length, 0);
  assert.deepEqual(preview.changes.map(c => [c.locale, c.target, c.action]), [['en-US', 'version', 'update'], ['tr', 'appInfo', 'create'], ['tr', 'version', 'create']]);
  assert.deepEqual(preview.changes[0]!.fields, { description: { from: 'old', to: 'new' } });
  const run = await syncMetadata({ account, appId: '123', versionId: 'v', metadata, execute: true }, f.api);
  assert.deepEqual(run.applied, ['en-US:version', 'tr:appInfo', 'tr:version']);
  await assert.rejects(syncMetadata({ account, appId: '123', versionId: 'v', metadata: { locales: { 'en-US': { description: 'ok' }, de: { keywords: 'x'.repeat(101) } } }, execute: true }, f.api), /100 bytes/);
  assert.equal(f.writes().length, 3);
  await assert.rejects(syncMetadata({ account, appId: '123', versionId: 'v', metadata: { locales: { fr: { subtitle: 'x' } } } }, f.api), /name is required/);
  await assert.rejects(syncMetadata({ account: readOnly, appId: '123', versionId: 'v', metadata, execute: true }, f.api), /read-only/);
  const dir = mkdtempSync(join(tmpdir(), 'prep-'));
  try {
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ locales: { tr: { nmae: 'typo' } } }));
    await assert.rejects(readMetadataFile(join(dir, 'm.json')));
  } finally { rmSync(dir, { recursive: true }); }
});
test('screenshot sync follows the folder, keeps placed files and needs replace for others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  mkdirSync(join(dir, 'tr', 'IPHONE'), { recursive: true });
  writeFileSync(join(dir, 'tr', 'IPHONE', '10.png'), png(1, 2)); writeFileSync(join(dir, 'tr', 'IPHONE', '2.png'), png(1, 3));
  let placements: { id: string; image: string }[] = [];
  let nextImage = 0;
  const ops = (size: number) => [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: size, requestHeaders: [] }];
  const images = new Map<string, ReturnType<typeof res>>();
  const f = fakeApi(base({
    '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'), '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'x', { locale: 'tr' })],
    '/v1/appStoreVersionLocalizations/loc/placements': (path: string) => { const image = new URL(path, 'https://example.test').searchParams.get('filter[image]'); return placements.filter(p => !image || p.image === image).map(p => res(p.id, 'appAssetLibraryPlacements', { placementType: 'APP_SCREENSHOT' })); },
    '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION' }, owned),
  }), { post: (path, body) => {
    if (path === '/v1/appAssetLibraryImages') { const id = `img${++nextImage}`; const image = res(id, 'appAssetLibraryImages', { state: 'AWAITING_UPLOAD', uploadOperations: ops(body.data.attributes.fileSize) }); images.set(id, image); return image; }
    if (path === '/v1/appAssetLibraryPlacements') { const id = `pl${placements.length + 1}-${body.data.relationships.image.data.id}`; placements.push({ id, image: body.data.relationships.image.data.id }); return res(id, 'appAssetLibraryPlacements'); }
    const order = body.data.relationships.orderedPlacements.data.map((x: { id: string }) => x.id);
    placements = order.map((id: string) => placements.find(p => p.id === id)!);
    return res('ord', 'appAssetLibraryPlacementOrderingRequests');
  } });
  const api = { ...f.api,
    get: async (path: string) => { const image = images.get(path.split('/').at(-1)!); return image ?? f.api.get(path); },
    patch: async (p: string, t: string, id: string, a: Record<string, unknown>) => { images.set(id, res(id, 'appAssetLibraryImages', { state: 'UPLOAD_COMPLETE' })); return f.api.patch(p, t, id, a); },
    delete: async (path: string) => { placements = placements.filter(p => !path.endsWith(p.id)); return f.api.delete(path); },
  };
  const fetcher = (async () => new Response(null)) as unknown as typeof fetch;
  const store = new PlanStore(':memory:');
  const input = { account, appId: '123', versionId: 'v', dir };
  try {
    assert.deepEqual((await scanScreenshots(dir)).map(s => s.filePath.split('/').at(-1)), ['2.png', '10.png']);
    const preview = await syncScreenshots(input, api, store, fetcher);
    assert.equal(preview.dryRun, true); assert.equal(f.writes().length, 0);
    await syncScreenshots({ ...input, execute: true }, api, store, fetcher);
    assert.deepEqual(placements.map(p => p.image), ['img1', 'img2']);
    // Rerun with one file reordered by name: nothing is uploaded again.
    const uploads = f.writes().filter(w => w.path === '/v1/appAssetLibraryImages').length;
    await syncScreenshots({ ...input, execute: true }, api, store, fetcher);
    assert.equal(f.writes().filter(w => w.path === '/v1/appAssetLibraryImages').length, uploads);
    // A screenshot from elsewhere blocks until replace is passed.
    placements.push({ id: 'foreign', image: 'other' });
    const blocked = await syncScreenshots(input, api, store, fetcher);
    assert.match(String((blocked as { note?: string }).note), /--replace/);
    await assert.rejects(syncScreenshots({ ...input, execute: true }, api, store, fetcher), /--replace/);
    writeFileSync(join(dir, 'tr', 'IPHONE', '3.png'), png(2, 3));
    const beforeReplace = f.calls.length;
    await syncScreenshots({ ...input, replace: true, execute: true }, api, store, fetcher);
    assert.deepEqual(placements.map(p => p.image), ['img1', 'img3', 'img2']);
    const replaceCalls = f.calls.slice(beforeReplace);
    assert(replaceCalls.findIndex(c => c.path === '/v1/appAssetLibraryImages') < replaceCalls.findIndex(c => c.path === '/v1/appAssetLibraryPlacements/foreign'));
    await assert.rejects(syncScreenshots({ ...input, dir: join(dir, 'missing') }, api, store, fetcher));
    await assert.rejects(syncScreenshots({ ...input, account: readOnly, execute: true }, api, store, fetcher), /read-only/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('preview videos upload as previews and place idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prev-')); const filePath = join(dir, 'p.mp4');
  const bytes = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypmp42'), Buffer.alloc(20)]); writeFileSync(filePath, bytes);
  const f = fakeApi(base({ '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'), '/v1/appAssetLibraryVideos/vid': res('vid', 'appAssetLibraryVideos', { state: 'UPLOAD_COMPLETE' }),
    '/v1/appAssetLibraries/lib/videos': [res('vid', 'appAssetLibraryVideos', { state: 'UPLOAD_COMPLETE' })],
    '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'x', { locale: 'tr' })] }),
    { post: (path, body) => path === '/v1/appAssetLibraryVideos' ? res('vid', 'appAssetLibraryVideos', { ...body.data.attributes, state: 'AWAITING_UPLOAD', uploadOperations: [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: bytes.length, requestHeaders: [] }] }) : res('pl', 'appAssetLibraryPlacements') });
  const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
  try {
    assert.equal((await uploadPreview({ ...write, filePath }, f.api, fetcher)).kind, 'video');
    assert.equal((f.writes()[0]!.body as any).data.attributes.category, 'APP_SCREENSHOTS_AND_PREVIEWS');
    const place = { ...write, versionId: 'v', localizationId: 'loc', videoId: 'vid', placementGroup: 'IPHONE' };
    assert.equal((await placePreview(place, f.api)).status, 'created');
    assert.equal((f.writes().at(-1)!.body as any).data.attributes.placementType, 'APP_PREVIEW');
    const again = fakeApi(base({ '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'), '/v1/appAssetLibraries/lib/videos': [res('vid', 'x', { state: 'COMPLETE' })],
      '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'x', { locale: 'tr' })], '/v1/appStoreVersionLocalizations/loc/placements': [res('pl', 'x')] }));
    assert.deepEqual(await placePreview(place, again.api), { status: 'exists', placementId: 'pl' });
    writeFileSync(join(dir, 'a.png'), png(1, 1));
    await assert.rejects(uploadPreview({ ...write, filePath: join(dir, 'a.png') }, f.api, fetcher), /must be MOV/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('Mac builds use pkg and platforms must match the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-')); const pkg = join(dir, 'app.pkg'); writeFileSync(pkg, Buffer.concat([Buffer.from('xar!'), Buffer.alloc(8)]));
  const ipa = join(dir, 'app.ipa'); writeFileSync(ipa, Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.alloc(8)]));
  const bodies: any[] = [];
  const api = withContract({ list: async () => ({ data: [], truncated: false }), patch: async () => ({}),
    get: async () => ({ id: 'u', type: 'buildUploads', attributes: { state: { state: 'PROCESSING' } } }),
    post: async (path: string, body: any) => { bodies.push(body); return path === '/v1/buildUploads' ? { id: 'u', type: 'buildUploads', attributes: {} } : { id: 'f', type: 'buildUploadFiles', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: 12, requestHeaders: [] }] } }; } });
  const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
  const input = { account, appId: '123', version: '1.0.0', build: '1' };
  try {
    await uploadBuild({ ...input, filePath: pkg, platform: 'MAC_OS' }, api, fetcher);
    assert.equal(bodies[0].data.attributes.platform, 'MAC_OS');
    assert.equal(bodies[1].data.attributes.uti, 'com.apple.pkg');
    await assert.rejects(uploadBuild({ ...input, filePath: ipa, platform: 'MAC_OS' }, api, fetcher), /\.pkg/);
    await assert.rejects(uploadBuild({ ...input, filePath: pkg }, api, fetcher), /\.pkg/);
    await uploadBuild({ ...input, filePath: ipa, platform: 'VISION_OS' }, api, fetcher);
    assert.equal(bodies[2].data.attributes.platform, 'VISION_OS');
    void resumeBuild;
  } finally { rmSync(dir, { recursive: true }); }
});
test('individual keys sign with sub and no issuer; team keys need an issuer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ind-')); const path = join(dir, 'k.p8');
  writeFileSync(path, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  try {
    const parsed = configSchema.parse({ accounts: [{ name: 'me', keyType: 'individual', keyId: 'ABCDEFGHIJ', privateKeyPath: path }] }).accounts[0]!;
    const claims = JSON.parse(Buffer.from(createTokenProvider(parsed)().split('.')[1]!, 'base64url').toString());
    assert.equal(claims.sub, 'user'); assert.equal(claims.iss, undefined);
    assert.throws(() => configSchema.parse({ accounts: [{ name: 'me', keyId: 'ABCDEFGHIJ', privateKeyPath: path }] }));
    assert.throws(() => configSchema.parse({ accounts: [{ name: 'me', keyType: 'individual', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: path }] }));
  } finally { rmSync(dir, { recursive: true }); }
});
test('schema check follows Apple rules for allowed forms and unknown fields', () => {
  const placement = requestSchema('AppAssetLibraryPlacementCreateRequest')!;
  const data = (attributes: unknown, relationships: unknown) => ({ data: { type: 'appAssetLibraryPlacements', attributes, relationships } });
  assert.deepEqual(checkSchema(placement, data({ placementType: 'APP_SCREENSHOT' }, { image: { data: { type: 'appAssetLibraryImages', id: 'i' } }, appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: 'l' } } })), []);
  assert(checkSchema(placement, data({ placementType: 'WRONG' }, {})).some(p => /must be one of/.test(p)));
  assert(checkSchema(placement, data({ placementType: 'APP_SCREENSHOT' }, { image: { data: { type: 'appAssetLibraryImages', id: 'i' } } })).some(p => /required by every allowed form/.test(p)));
  assert(checkSchema(placement, { data: { type: 'appAssetLibraryPlacements', extra: 1 } }).some(p => /not a known field/.test(p)));
  assert(checkSchema(placement, null).length > 0);
});
test('generic plans validate against Apple, bind to a digest and never retry unknown outcomes', async () => {
  const store = new PlanStore(':memory:');
  const open = { ...account, genericWrites: true };
  const body = { data: { type: 'appEvents', attributes: { referenceName: 'Launch' }, relationships: { app: { data: { type: 'apps', id: '123' } } } } };
  const sent: unknown[] = [];
  let mode: 'ok' | 'refuse' | 'lost' = 'ok';
  const api = { request: async (method: string, path: string, payload?: unknown) => {
    if (mode === 'refuse') throw new AppleError(409, []);
    if (mode === 'lost') throw new TypeError('socket hang up');
    sent.push([method, path, payload]); return { data: { id: 'new' } };
  } };
  try {
    const plan = createApiPlan({ account: open, appId: '123', method: 'POST', path: '/v1/appEvents', requestBody: body, note: 'launch event' }, store);
    assert.equal(sent.length, 0);
    assert.throws(() => createApiPlan({ account: open, appId: '123', method: 'POST', path: '/v1/nonsense', requestBody: body }, store), /not in the API catalog/);
    assert.throws(() => createApiPlan({ account: open, appId: '123', method: 'POST', path: '/v1/appEvents', requestBody: { data: { type: 'wrong' } } }, store), /does not match/);
    assert.throws(() => createApiPlan({ account: open, appId: '123', method: 'GET', path: '/v1/apps' }, store), /POST, PATCH or DELETE/);
    assert.throws(() => createApiPlan({ account: open, appId: 'abc', method: 'DELETE', path: '/v1/appEvents/1' }, store), /numeric/);
    assert.throws(() => createApiPlan({ account: open, appId: '123', method: 'PATCH', path: '/v1/appStoreReviewDetails/1', requestBody: { data: { type: 'appStoreReviewDetails', id: '1', attributes: { demoAccountPassword: 'x' } } } }, store), /credential field/);
    await assert.rejects(applyApiPlan(plan.id, 'wrong', open, store, api), /Digest/);
    await assert.rejects(applyApiPlan(plan.id, plan.digest, account, store, api), /Generic writes are off/);
    await assert.rejects(applyApiPlan(plan.id, plan.digest, { ...open, allowedAppIds: [] }, store, api), /allowlist/);
    await assert.rejects(applyApiPlan(plan.id, plan.digest, { ...open, keyId: 'ZZZZZZZZZZ' }, store, api), /credentials changed/);
    mode = 'refuse';
    await assert.rejects(applyApiPlan(plan.id, plan.digest, open, store, api), /409/);
    assert.equal(store.apiPlan(plan.id).status, 'failed');
    mode = 'ok';
    assert.equal((await applyApiPlan(plan.id, plan.digest, open, store, api)).status, 'completed');
    await applyApiPlan(plan.id, plan.digest, open, store, api);
    assert.equal(sent.length, 1);
    mode = 'lost';
    const second = createApiPlan({ account: open, appId: '123', method: 'DELETE', path: '/v1/appEvents/9' }, store);
    await assert.rejects(applyApiPlan(second.id, second.digest, open, store, api), /socket/);
    mode = 'ok';
    await assert.rejects(applyApiPlan(second.id, second.digest, open, store, api), /unknown outcome/);
    assert.equal(sent.length, 1);
    const expiring = createApiPlan({ account: open, appId: '123', method: 'DELETE', path: '/v1/appEvents/8' }, store);
    const realNow = Date.now; Date.now = () => realNow() + 31 * 60_000;
    try { await assert.rejects(applyApiPlan(expiring.id, expiring.digest, open, store, api), /expired/); } finally { Date.now = realNow; }
  } finally { store.close(); }
});
