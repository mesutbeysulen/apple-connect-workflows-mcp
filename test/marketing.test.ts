import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/marketing.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const base = { account, appId: '123' };
const app = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/apps/123/assetLibrary': res('lib', 'appAssetLibraries'),
  '/v1/appAssetLibraries/lib/images': (path: string) => new URL(path, 'https://x').searchParams.get('filter[id]') === 'img' ? [res('img', 'appAssetLibraryImages', { state: 'APPROVED' })] : [],
  '/v1/appAssetLibraries/lib/videos': (path: string) => new URL(path, 'https://x').searchParams.get('filter[id]') === 'vid' ? [res('vid', 'appAssetLibraryVideos', { state: 'COMPLETE' })] : [],
  '/v1/apps/123/appCustomProductPages': [res('page', 'appCustomProductPages', { name: 'Spring', visible: false })],
  '/v1/appCustomProductPages/page/appCustomProductPageVersions': [res('pv', 'appCustomProductPageVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
  '/v1/appCustomProductPageVersions/pv/appCustomProductPageLocalizations': [res('cl', 'appCustomProductPageLocalizations', { locale: 'en-US', promotionalText: 'Hi' })],
  '/v1/apps/123/appEvents': [res('ev', 'appEvents', { referenceName: 'Launch' })],
  '/v1/appEvents/ev/localizations': [res('el', 'appEventLocalizations', { locale: 'en-US' })],
  '/v1/apps/123/appStoreVersionExperimentsV2': [res('ex', 'appStoreVersionExperiments', { name: 'Icons', trafficProportion: 30, started: false })],
  '/v2/appStoreVersionExperiments/ex/appStoreVersionExperimentTreatments': [res('tr', 'appStoreVersionExperimentTreatments', { name: 'Blue' })],
  '/v1/appStoreVersionExperimentTreatments/tr/appStoreVersionExperimentTreatmentLocalizations': [res('tl', 'appStoreVersionExperimentTreatmentLocalizations', { locale: 'en-US' })],
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split('/').at(-1)}`, body.data.type) });

test('custom product pages are created once with an editable version, then edited and localized', async () => {
  const f = app({ '/v1/apps/123/appCustomProductPages': [], '/v1/appCustomProductPages/new-appCustomProductPages/appCustomProductPageVersions': [] });
  const created = await m.createCustomPage({ ...base, name: 'Summer', deepLink: 'myapp://summer' }, f.api);
  assert.deepEqual([created.status, created.versionCreated], ['created', true]);
  assert.equal((f.writes()[1]!.body as any).data.attributes.deepLink, 'myapp://summer');
  const again = app();
  assert.deepEqual(await m.createCustomPage({ ...base, name: 'Spring' }, again.api), { status: 'exists', pageId: 'page', versionId: 'pv', versionCreated: false });
  assert.equal(again.writes().length, 0);
  assert.deepEqual((await m.updateCustomPage({ ...base, pageId: 'page', visible: true }, again.api) as { changed?: string[] }).changed, ['visible']);
  assert.equal((await m.localizeCustomPage({ ...base, versionId: 'pv', locale: 'en-US', promotionalText: 'Hi' }, again.api)).status, 'unchanged');
  assert.equal((await m.localizeCustomPage({ ...base, versionId: 'pv', locale: 'tr', promotionalText: 'Merhaba' }, again.api)).status, 'created');
  await assert.rejects(m.localizeCustomPage({ ...base, versionId: 'pv', locale: 'tr', promotionalText: 'x'.repeat(171) }, again.api), /170/);
  await assert.rejects(m.updateCustomPage({ ...base, pageId: 'other', name: 'x' }, again.api), /does not belong/);
  await assert.rejects(m.createCustomPage({ ...base, name: 'X', deepLink: 'not a link' }, again.api), /deep link/i);
  await assert.rejects(m.createCustomPage({ ...base, account: readOnly, name: 'X' }, again.api), /read-only/);
  assert.deepEqual(await m.deleteCustomPage({ ...base, pageId: 'page' }, again.api), { removed: 'page' });
});
test('in-app events validate their schedule and text limits', async () => {
  const f = app();
  const schedule = { territories: ['USA', 'TUR'], publishStart: '2027-01-01T09:00:00Z', eventStart: '2027-01-02T09:00:00Z', eventEnd: '2027-01-09T09:00:00Z' };
  assert.equal((await m.createEvent({ ...base, referenceName: 'Launch' }, f.api)).status, 'exists');
  const created = await m.createEvent({ ...base, referenceName: 'Season 2', badge: 'NEW_SEASON', purpose: 'BRING_BACK_LAPSED_USERS', priority: 'HIGH', ...schedule }, f.api);
  assert.equal(created.status, 'created');
  assert.deepEqual((f.writes()[0]!.body as any).data.attributes.territorySchedules, [schedule]);
  await assert.rejects(m.createEvent({ ...base, referenceName: 'X', ...schedule, eventEnd: '2027-01-01T00:00:00Z' }, f.api), /publish <= start < end/);
  await assert.rejects(m.createEvent({ ...base, referenceName: 'X', ...schedule, eventStart: '2027-01-02' }, f.api), /time zone/);
  await assert.rejects(m.createEvent({ ...base, referenceName: 'X', territories: ['USA'] }, f.api), /--publish/);
  await assert.rejects(m.createEvent({ ...base, referenceName: 'X', badge: 'PARTY' }, f.api), /Badge/);
  assert.deepEqual((await m.updateEvent({ ...base, eventId: 'ev', priority: 'NORMAL' }, f.api) as { changed?: string[] }).changed, ['priority']);
  await assert.rejects(m.updateEvent({ ...base, eventId: 'ev' }, f.api), /field to change/);
  assert.equal((await m.localizeEvent({ ...base, eventId: 'ev', locale: 'tr', name: 'Sezon 2', shortDescription: 'Kısa', longDescription: 'Uzun' }, f.api)).status, 'created');
  await assert.rejects(m.localizeEvent({ ...base, eventId: 'ev', locale: 'tr', name: 'x'.repeat(31) }, f.api), /30/);
  await assert.rejects(m.deleteEvent({ ...base, eventId: 'nope' }, f.api), /does not belong/);
});
test('experiments, treatments and starting a test', async () => {
  const f = app();
  assert.equal((await m.createExperiment({ ...base, name: 'Icons', platform: 'IOS', trafficProportion: 30 }, f.api)).status, 'exists');
  assert.equal((await m.createExperiment({ ...base, name: 'Screens', platform: 'IOS', trafficProportion: 50 }, f.api)).status, 'created');
  await assert.rejects(m.createExperiment({ ...base, name: 'X', platform: 'IOS', trafficProportion: 0 }, f.api), /1 to 100/);
  assert.equal((await m.createTreatment({ ...base, experimentId: 'ex', name: 'Blue' }, f.api)).status, 'exists');
  assert.equal((await m.createTreatment({ ...base, experimentId: 'ex', name: 'Green', appIconName: 'AppIconGreen' }, f.api)).status, 'created');
  assert.equal((await m.localizeTreatment({ ...base, treatmentId: 'tr', locale: 'en-US' }, f.api)).status, 'unchanged');
  assert.equal((await m.localizeTreatment({ ...base, treatmentId: 'tr', locale: 'tr' }, f.api)).status, 'created');
  assert.deepEqual((await m.updateExperiment({ ...base, experimentId: 'ex', started: true }, f.api) as { changed?: string[] }).changed, ['started']);
  assert.equal((await m.updateExperiment({ ...base, experimentId: 'ex', trafficProportion: 30 }, f.api)).status, 'unchanged');
  await assert.rejects(m.createTreatment({ ...base, experimentId: 'other', name: 'X' }, f.api), /does not belong/);
});
test('marketing media is placed from the library on owned localizations only', async () => {
  const f = app();
  const place = { ...base, kind: 'image' as const, assetId: 'img' };
  assert.equal((await m.placeMarketingAsset({ ...place, target: 'cpp', localizationId: 'cl', placementType: 'APP_SCREENSHOT', placementGroup: 'IPHONE' }, f.api)).status, 'created');
  const body = f.writes()[0]!.body as any;
  assert.equal(body.data.relationships.appCustomProductPageLocalization.data.id, 'cl');
  await m.placeMarketingAsset({ ...place, target: 'event', localizationId: 'el', placementType: 'EVENT_CARD_ASSET' }, f.api);
  assert.equal((f.writes()[1]!.body as any).data.relationships.appEventLocalization.data.id, 'el');
  await m.placeMarketingAsset({ ...base, kind: 'video', assetId: 'vid', target: 'experiment', localizationId: 'tl', placementType: 'APP_PREVIEW', placementGroup: 'IPHONE' }, f.api);
  await assert.rejects(m.placeMarketingAsset({ ...place, target: 'event', localizationId: 'el', placementType: 'APP_SCREENSHOT', placementGroup: 'G' }, f.api), /must be one of EVENT_CARD_ASSET/);
  await assert.rejects(m.placeMarketingAsset({ ...place, target: 'cpp', localizationId: 'cl', placementType: 'APP_SCREENSHOT' }, f.api), /--placement-group/);
  await assert.rejects(m.placeMarketingAsset({ ...place, target: 'cpp', localizationId: 'cl', placementType: 'APP_PREVIEW', placementGroup: 'G' }, f.api), /need a video/);
  await assert.rejects(m.placeMarketingAsset({ ...place, target: 'cpp', localizationId: 'foreign', placementType: 'PRODUCT_PAGE_HEADER_ASSET' }, f.api), /does not belong/);
  await assert.rejects(m.placeMarketingAsset({ ...place, assetId: 'stranger', target: 'cpp', localizationId: 'cl', placementType: 'PRODUCT_PAGE_HEADER_ASSET' }, f.api), /not in this app/);
  const placed = app({ '/v1/appCustomProductPageLocalizations/cl/placements': [res('p1', 'x', {}, { image: { data: { id: 'img', type: 'appAssetLibraryImages' } } })] });
  assert.deepEqual(await m.placeMarketingAsset({ ...place, target: 'cpp', localizationId: 'cl', placementType: 'PRODUCT_PAGE_HEADER_ASSET' }, placed.api), { status: 'exists', placementId: 'p1' });
  assert.equal(placed.writes().length, 0);
});
test('ordering marketing media needs an exact permutation and verifies it', async () => {
  let order = ['a', 'b'];
  const f = app({ '/v1/appCustomProductPageLocalizations/cl/placements': () => order.map(id => res(id, 'appAssetLibraryPlacements')) });
  const api = { ...f.api, post: async (path: string, body: any) => { const r = await f.api.post(path, body); order = body.data.relationships.orderedPlacements.data.map((x: any) => x.id); return r; } };
  const input = { ...base, target: 'cpp' as const, localizationId: 'cl', placementGroup: 'IPHONE' };
  assert.equal((await m.orderMarketingAssets({ ...input, placementIds: ['a', 'b'] }, api)).status, 'unchanged');
  assert.deepEqual(await m.orderMarketingAssets({ ...input, placementIds: ['b', 'a'] }, api), { status: 'reordered', order: ['b', 'a'] });
  assert.equal((f.writes()[0]!.body as any).data.relationships.appCustomProductPageLocalization.data.id, 'cl');
  await assert.rejects(m.orderMarketingAssets({ ...input, placementIds: ['a'] }, api), /every current placement/);
});
test('marketing items go to App Review as their own submission items', async () => {
  const f = app({ '/v1/apps/123/reviewSubmissions': [], '/v1/reviewSubmissions/new-reviewSubmissions': res('new-reviewSubmissions', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }) });
  for (const [kind, id, relation] of [['cpp', 'pv', 'appCustomProductPageVersion'], ['experiment', 'ex', 'appStoreVersionExperimentV2'], ['event', 'ev', 'appEvent']] as const) {
    await m.submitMarketing({ ...base, kind, id }, f.api);
    const item = f.writes().filter(w => w.path === '/v1/reviewSubmissionItems').at(-1)!.body as any;
    assert.equal(item.data.relationships[relation].data.id, id);
  }
  await assert.rejects(m.submitMarketing({ ...base, kind: 'event', id: 'nope' }, f.api), /does not belong/);
});
