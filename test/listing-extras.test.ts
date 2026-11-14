import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as l from '../src/listing-extras.js';
import * as x from '../src/commerce-extras.js';
import { account, readOnly, res, fakeApi, png } from './helpers.js';

const owned = { app: { data: { id: '123', type: 'apps' } } };
const ops = (size: number) => [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: size, requestHeaders: [] }];
const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
const app = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/territories': [res('USA', 'territories'), res('TUR', 'territories')],
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION' }, owned),
  '/v1/apps/123/accessibilityDeclarations': [],
  '/v1/apps/123/appClips': [res('clip', 'appClips')],
  '/v1/appClips/clip/appClipDefaultExperiences': [res('exp', 'appClipDefaultExperiences', { action: 'OPEN' })],
  '/v1/appClipDefaultExperiences/exp/appClipDefaultExperienceLocalizations': [res('expl', 'appClipDefaultExperienceLocalizations', { locale: 'en-US', subtitle: 'Order coffee' })],
  '/v1/apps/123/backgroundAssets': [res('pack', 'backgroundAssets', { assetPackIdentifier: 'Levels' })],
  '/v1/backgroundAssets/pack/versions': [res('pv1', 'backgroundAssetVersions')],
  '/v1/apps/123/appCustomProductPages': [res('page', 'appCustomProductPages')],
  '/v1/appCustomProductPages/page/appCustomProductPageVersions': [res('ver', 'appCustomProductPageVersions')],
  '/v1/appCustomProductPageVersions/ver/appCustomProductPageLocalizations': [res('cl', 'appCustomProductPageLocalizations', { locale: 'en-US' })],
  '/v1/appCustomProductPageLocalizations/cl': res('cl', 'appCustomProductPageLocalizations', { locale: 'en-US' }),
  '/v1/apps/123/searchKeywords': [res('puzzle', 'appKeywords'), res('brain', 'appKeywords'), res('logic', 'appKeywords')],
  '/v1/appCustomProductPageLocalizations/cl/searchKeywords': [res('logic', 'appKeywords')],
  '/v1/alternativeDistributionDomains': [res('dom', 'alternativeDistributionDomains', { domain: 'apps.example.com' })],
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split('/').at(-1)}`, body.data.type, { uploadOperations: ops(body.data.attributes?.fileSize ?? 1) }) });
const base = { account, appId: '123' };

test('EULA previews, then creates or updates; removing restores Apple standard terms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eula-')); const filePath = join(dir, 'eula.txt'); writeFileSync(filePath, 'Our terms.');
  try {
    const f = app();
    assert.equal((await l.setEula({ ...base, account: readOnly, filePath, territories: 'all' }, f.api)).dryRun, true);
    assert.equal((await l.setEula({ ...base, filePath, territories: ['USA'], execute: true }, f.api) as { status?: string }).status, 'created');
    assert.deepEqual((f.writes()[0]!.body as any).data.relationships.territories.data, [{ type: 'territories', id: 'USA' }]);
    const existing = app({ '/v1/apps/123/endUserLicenseAgreement': res('eula', 'endUserLicenseAgreements') });
    assert.equal((await l.setEula({ ...base, filePath, territories: 'all', execute: true }, existing.api) as { status?: string }).status, 'updated');
    await assert.rejects(l.setEula({ ...base, filePath, territories: ['XXX'] }, f.api), /Unknown territories/);
    assert.equal((await l.removeEula({ ...base }, existing.api)).dryRun, true);
    assert.equal((await l.removeEula({ ...base, execute: true }, existing.api) as { status?: string }).status, 'removed');
    assert.equal((await l.removeEula({ ...base }, f.api)).status, 'none');
  } finally { rmSync(dir, { recursive: true }); }
});
test('accessibility sets every feature explicitly and can publish', async () => {
  const f = app();
  const r = await l.setAccessibility({ ...base, device: 'IPHONE', supports: ['voiceover', 'larger-text'], publish: true }, f.api);
  assert.equal(r.status, 'created');
  const attrs = (f.writes()[0]!.body as any).data.attributes;
  assert.equal(attrs.supportsVoiceover, true); assert.equal(attrs.supportsCaptions, false);
  assert.deepEqual(f.writes()[1]!.body, { publish: true });
  await assert.rejects(l.setAccessibility({ ...base, device: 'IPHONE', supports: ['telepathy'] }, f.api), /Unknown features/);
  const same = app({ '/v1/apps/123/accessibilityDeclarations': [res('ad', 'accessibilityDeclarations', { deviceFamily: 'IPAD', ...Object.fromEntries(Object.values(l.ACCESSIBILITY_FEATURES).map(k => [k, false])) })] });
  assert.equal((await l.setAccessibility({ ...base, device: 'IPAD', supports: [] }, same.api)).status, 'unchanged');
});
test('routing coverage needs exactly one MultiPolygon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-')); const filePath = join(dir, 'c.geojson');
  try {
    writeFileSync(filePath, JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }));
    const f = app({ '/v1/appStoreVersions/v/routingAppCoverage': res('old', 'routingAppCoverages') });
    const r = await l.uploadRoutingCoverage({ ...base, versionId: 'v', filePath }, f.api, fetcher);
    assert.equal(r.replaced, 'old');
    assert.deepEqual(f.writes().map(w => w.method), ['DELETE', 'POST', 'PATCH']);
    writeFileSync(filePath, JSON.stringify({ type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon' } }] }));
    await assert.rejects(l.uploadRoutingCoverage({ ...base, versionId: 'v', filePath }, f.api, fetcher), /exactly one MultiPolygon/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('custom page keywords use only the app\'s own keywords and send the difference', async () => {
  const f = app();
  const r = await l.setCustomPageKeywords({ ...base, localizationId: 'cl', keywords: ['Puzzle', 'brain'] }, f.api);
  assert.deepEqual([r.added, r.removed], [['puzzle', 'brain'], ['logic']]);
  assert.deepEqual(f.writes().map(w => w.method), ['POST', 'DELETE']);
  await assert.rejects(l.setCustomPageKeywords({ ...base, localizationId: 'cl', keywords: ['racing'] }, f.api), /Not in the app's en-US keywords: racing/);
  await assert.rejects(l.setCustomPageKeywords({ ...base, localizationId: 'cl', keywords: ['x'] }, app({ '/v1/apps/123/appCustomProductPages': [] }).api), /does not belong/);
});
test('App Clip experience, subtitle, header size and review URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clip-'));
  const good = join(dir, 'h.png'); writeFileSync(good, png(1800, 1200));
  const bad = join(dir, 'b.png'); writeFileSync(bad, png(1200, 1200));
  try {
    const f = app();
    assert.equal((await l.setClipDefaultExperience({ ...base, clipId: 'clip', action: 'PLAY', versionId: 'v' }, f.api)).status, 'updated');
    assert.equal((await l.localizeClipExperience({ ...base, experienceId: 'exp', locale: 'en-US', subtitle: 'Order coffee' }, f.api)).status, 'unchanged');
    assert.equal((await l.localizeClipExperience({ ...base, experienceId: 'exp', locale: 'tr', subtitle: 'Kahve sipariş et' }, f.api)).status, 'created');
    assert.equal((await l.uploadClipHeader({ ...base, experienceId: 'exp', locale: 'en-US', filePath: good }, f.api, fetcher)).status, 'uploaded');
    await assert.rejects(l.uploadClipHeader({ ...base, experienceId: 'exp', locale: 'en-US', filePath: bad }, f.api, fetcher), /1800x1200/);
    assert.equal((await l.setClipReviewUrls({ ...base, experienceId: 'exp', urls: ['https://example.com/clip'] }, f.api)).status, 'created');
    await assert.rejects(l.setClipReviewUrls({ ...base, experienceId: 'exp', urls: ['http://x'] }, f.api), /https/);
    await assert.rejects(l.setClipDefaultExperience({ ...base, clipId: 'other', action: 'OPEN' }, f.api), /does not belong/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('asset packs: create once, upload a new version with manifest check, submit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-')); const archive = join(dir, 'Levels.aar'); const manifest = join(dir, 'Manifest.json');
  writeFileSync(archive, 'archive-bytes'); writeFileSync(manifest, '{"assetPackID":"Levels"}');
  try {
    const f = app({ '/v1/apps/123/reviewSubmissions': [], '/v1/reviewSubmissions/new-reviewSubmissions': res('new-reviewSubmissions', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }) });
    assert.equal((await l.createAssetPack({ ...base, identifier: 'Levels' }, app({ '/v1/apps/123/backgroundAssets': [res('pack', 'x')] }).api)).status, 'exists');
    assert.equal((await l.uploadAssetPackVersion({ ...base, assetPackId: 'pack', archivePath: archive, manifestPath: manifest }, f.api, fetcher)).dryRun, true);
    assert.equal(f.writes().length, 0);
    const r = await l.uploadAssetPackVersion({ ...base, assetPackId: 'pack', archivePath: archive, manifestPath: manifest, execute: true }, f.api, fetcher);
    assert.equal((r as { status?: string }).status, 'uploaded');
    assert.deepEqual(f.writes().filter(w => w.path === '/v1/backgroundAssetUploadFiles').map(w => (w.body as any).data.attributes.assetType), ['MANIFEST', 'ASSET']);
    await assert.rejects(l.uploadAssetPackVersion({ ...base, assetPackId: 'pack', archivePath: manifest }, f.api, fetcher), /\.aar/);
    await l.submitAssetPackVersion({ ...base, assetPackId: 'pack', versionId: 'pv1' }, f.api);
    assert.equal((f.writes().find(w => w.path === '/v1/reviewSubmissionItems')!.body as any).data.relationships.backgroundAssetVersion.data.id, 'pv1');
  } finally { rmSync(dir, { recursive: true }); }
});
test('EU distribution: public key only, domains once, catalog URL, package per version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alt-')); const key = join(dir, 'k.pem');
  try {
    writeFileSync(key, '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n');
    const f = app();
    assert.equal((await l.setDistributionKey({ ...base, publicKeyPath: key }, f.api)).status, 'created');
    writeFileSync(key, '-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----\n');
    await assert.rejects(l.setDistributionKey({ ...base, publicKeyPath: key }, f.api), /private key/);
    assert.equal((await l.addDistributionDomain({ account, domain: 'apps.example.com', referenceName: 'Main' }, f.api)).status, 'exists');
    await assert.rejects(l.addDistributionDomain({ account: readOnly, domain: 'b.example.com', referenceName: 'B' }, f.api), /read-only/);
    assert.equal((await l.setMarketplaceSearch({ ...base, catalogUrl: 'https://store.example.com/catalog' }, f.api)).status, 'created');
    assert.equal((await l.createDistributionPackage({ ...base, versionId: 'v' }, f.api)).status, 'created');
  } finally { rmSync(dir, { recursive: true }); }
});
const shop = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/apps/123/subscriptionGroups': [res('g1', 'subscriptionGroups')],
  '/v1/subscriptionGroups/g1/subscriptions': [res('sub1', 'subscriptions'), res('sub2', 'subscriptions')],
  '/v1/subscriptions/sub1/pricePoints': (path: string) => new URL(path, 'https://x').searchParams.get('filter[territory]') === 'USA' ? [res('p-usa', 'subscriptionPricePoints', { customerPrice: '4.99' })] : [res('p-tur', 'subscriptionPricePoints', { customerPrice: '99.99' })],
  '/v1/subscriptions/sub1/winBackOffers': [res('wb-old', 'winBackOffers', { offerId: 'old_offer', priority: 'NORMAL' })],
  '/v1/apps/123/retentionMessages': [res('rm', 'retentionMessages', { referenceName: 'Stay' })],
  '/v1/retentionMessages/rm/versions': [res('rmv', 'retentionMessageVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
  '/v1/retentionMessageVersions/rmv/localizations': [res('rml', 'retentionMessageLocalizations', { locale: 'en-US', header: 'Wait', body: 'Stay with us' })],
  '/v1/subscriptions/sub2/retentionMessage': res('rm', 'retentionMessages'),
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split('/').at(-1)}`, body.data.type) });
const winBack = { ...base, subscriptionId: 'sub1', referenceName: 'Come back', offerId: 'comeback_1', offerMode: 'PAY_UP_FRONT', duration: 'THREE_MONTHS', periodCount: 1,
  paidMonths: 6, lapsedMin: 2, lapsedMax: 24, waitMonths: 2, startDate: '2027-01-01', endDate: '2027-02-01', priority: 'HIGH', promoted: true, prices: x.parsePrices('USA=4.99,TUR=99.99') };
test('win-back offers follow Apple\'s documented request and validate eligibility', async () => {
  const f = shop();
  assert.equal((await x.createWinBackOffer(winBack, f.api)).dryRun, true);
  const r = await x.createWinBackOffer({ ...winBack, execute: true }, f.api);
  assert.equal((r as { url?: string }).url, 'https://apps.apple.com/win-back/new-winBackOffers');
  const body = f.writes()[0]!.body as any;
  assert.deepEqual(body.data.attributes.customerEligibilityTimeSinceLastSubscribedInMonths, { minimum: 2, maximum: 24 });
  assert.equal(body.data.attributes.promotionIntent, 'USE_AUTO_GENERATED_ASSETS');
  assert.deepEqual(body.included.map((p: any) => p.relationships.subscriptionPricePoint.data.id), ['p-usa', 'p-tur']);
  assert.deepEqual(body.data.relationships.prices.data.map((p: any) => p.id), body.included.map((p: any) => p.id));
  assert.equal((await x.createWinBackOffer({ ...winBack, offerId: 'old_offer', execute: true }, f.api) as { status?: string }).status, 'exists');
  await assert.rejects(x.createWinBackOffer({ ...winBack, offerMode: 'FREE_TRIAL' }, f.api), /PAY_AS_YOU_GO and PAY_UP_FRONT/);
  await assert.rejects(x.createWinBackOffer({ ...winBack, lapsedMin: 30 }, f.api), /cannot exceed/);
  await assert.rejects(x.createWinBackOffer({ ...winBack, endDate: '2026-12-01' }, f.api), /end after the start/);
  await assert.rejects(x.createWinBackOffer({ ...winBack, prices: [] }, f.api), /need --prices/);
  assert.deepEqual((await x.updateWinBackOffer({ ...base, subscriptionId: 'sub1', offerId: 'wb-old', priority: 'HIGH' }, f.api) as { changed?: string[] }).changed, ['priority']);
  assert.deepEqual(await x.deleteWinBackOffer({ ...base, subscriptionId: 'sub1', offerId: 'wb-old' }, f.api), { removed: 'wb-old' });
  await assert.rejects(x.deleteWinBackOffer({ ...base, subscriptionId: 'sub1', offerId: 'nope' }, f.api), /does not belong/);
});
test('retention messages: create with a version, localize, attach to subscriptions, submit', async () => {
  const f = shop({ '/v1/apps/123/reviewSubmissions': [], '/v1/reviewSubmissions/new-reviewSubmissions': res('new-reviewSubmissions', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }) });
  assert.deepEqual(await x.createRetentionMessage({ ...base, referenceName: 'Stay' }, f.api), { status: 'exists', messageId: 'rm', versionId: 'rmv' });
  const fresh = shop({ '/v1/apps/123/retentionMessages': [], '/v1/retentionMessages/new-retentionMessages/versions': [] });
  assert.equal((await x.createRetentionMessage({ ...base, referenceName: 'Wait' }, fresh.api)).status, 'created');
  assert.deepEqual(fresh.writes().map(w => w.path), ['/v1/retentionMessages', '/v1/retentionMessageVersions']);
  const full = shop({ '/v1/apps/123/retentionMessages': Array.from({ length: 10 }, (_, i) => res(`m${i}`, 'retentionMessages', { referenceName: `M${i}` })) });
  await assert.rejects(x.createRetentionMessage({ ...base, referenceName: 'Eleventh' }, full.api), /10 retention messages/);
  assert.equal((await x.localizeRetentionMessage({ ...base, messageId: 'rm', locale: 'en-US', header: 'Wait' }, f.api)).status, 'unchanged');
  assert.equal((await x.localizeRetentionMessage({ ...base, messageId: 'rm', locale: 'tr', header: 'Dur', body: 'Bizimle kal' }, f.api)).status, 'created');
  await assert.rejects(x.localizeRetentionMessage({ ...base, messageId: 'rm', locale: 'de', header: 'Halt' }, f.api), /--header and --body/);
  const attached = await x.attachRetentionMessage({ ...base, messageId: 'rm', subscriptionIds: ['sub1', 'sub2'] }, f.api);
  assert.deepEqual([attached.attached, attached.already], [['sub1'], ['sub2']]);
  assert.equal(await x.retentionVersionForReview(f.api, '123', 'rm'), 'rmv');
});
