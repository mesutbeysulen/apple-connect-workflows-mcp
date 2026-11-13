import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x from '../src/commerce-extras.js';
import { AppleError } from '../src/apple.js';
import { account, readOnly, res, fakeApi, png, assertContract } from './helpers.js';

const shop = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/apps/123/inAppPurchasesV2': [res('iap1', 'inAppPurchases')],
  '/v1/apps/123/subscriptionGroups': [res('g1', 'subscriptionGroups')],
  '/v1/subscriptionGroups/g1/subscriptions': [res('sub1', 'subscriptions')],
  '/v1/territories': [res('USA', 'territories'), res('TUR', 'territories'), res('DEU', 'territories')],
  '/v1/subscriptions/sub1/pricePoints': (path: string) => new URL(path, 'https://x').searchParams.get('filter[territory]') === 'USA' ? [res('s-usa', 'subscriptionPricePoints', { customerPrice: '0.99' })] : [res('s-tur', 'subscriptionPricePoints', { customerPrice: '29.99' })],
  '/v2/inAppPurchases/iap1/pricePoints': [res('i-usa', 'inAppPurchasePricePoints', { customerPrice: '0.99' })],
  '/v2/sandboxTesters': [res('t1', 'sandboxTesters', { territory: 'USA', interruptPurchases: false })],
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split("/").at(-1)}`, body.data.type) });
const base = { account, appId: '123' };

test('product availability previews a territory diff and replaces the list on execute', async () => {
  const f = shop({ '/v1/subscriptions/sub1/subscriptionAvailability': res('av', 'subscriptionAvailabilities', { availableInNewTerritories: false }), '/v1/subscriptionAvailabilities/av/availableTerritories': [res('USA', 'territories'), res('DEU', 'territories')] });
  const preview = await x.setProductAvailability({ ...base, account: readOnly, kind: 'subscription', productId: 'sub1', territories: ['USA', 'TUR'], availableInNewTerritories: false }, f.api);
  assert.deepEqual([preview.added, preview.removed], [['TUR'], ['DEU']]);
  assert.equal(f.writes().length, 0);
  await x.setProductAvailability({ ...base, kind: 'subscription', productId: 'sub1', territories: ['USA', 'TUR'], availableInNewTerritories: false, execute: true }, f.api);
  assert.deepEqual((f.writes()[0]!.body as any).data.relationships.availableTerritories.data.map((t: any) => t.id), ['USA', 'TUR']);
  const all = shop();
  const result = await x.setProductAvailability({ ...base, kind: 'iap', productId: 'iap1', territories: 'all', availableInNewTerritories: true, execute: true }, all.api);
  assert.deepEqual(result.added, ['USA', 'TUR', 'DEU']);
  assert.equal((all.writes()[0]!.body as any).data.relationships.inAppPurchase.data.id, 'iap1');
  const same = shop({ '/v2/inAppPurchases/iap1/inAppPurchaseAvailability': res('av', 'inAppPurchaseAvailabilities', { availableInNewTerritories: true }), '/v1/inAppPurchaseAvailabilities/av/availableTerritories': [res('USA', 't')] });
  assert.equal((await x.setProductAvailability({ ...base, kind: 'iap', productId: 'iap1', territories: ['USA'], availableInNewTerritories: true, execute: true }, same.api) as { status?: string }).status, 'unchanged');
  await assert.rejects(x.setProductAvailability({ ...base, kind: 'iap', productId: 'iap1', territories: ['XXX'], availableInNewTerritories: true }, all.api), /Unknown territories: XXX/);
  await assert.rejects(x.setProductAvailability({ ...base, kind: 'iap', productId: 'stranger', territories: ['USA'], availableInNewTerritories: true }, all.api), /does not belong/);
});
test('sandbox testers update only changed fields and history clears only known testers', async () => {
  const f = shop();
  assert.equal((await x.updateSandboxTester({ account, testerId: 't1', territory: 'USA' }, f.api)).status, 'unchanged');
  assert.deepEqual((await x.updateSandboxTester({ account, testerId: 't1', territory: 'TUR', renewalRate: 'MONTHLY_RENEWAL_EVERY_FIVE_MINUTES' }, f.api)).changed, ['territory', 'subscriptionRenewalRate']);
  await assert.rejects(x.updateSandboxTester({ account, testerId: 't1', renewalRate: 'FAST' }, f.api), /Renewal rate/);
  await assert.rejects(x.updateSandboxTester({ account: readOnly, testerId: 't1', territory: 'TUR' }, f.api), /read-only/);
  assert.deepEqual((await x.clearSandboxHistory({ account, testerIds: ['t1', 't1'] }, f.api)).cleared, ['t1']);
  await assert.rejects(x.clearSandboxHistory({ account, testerIds: ['ghost'] }, f.api), /not found/);
});
test('promotional offers resolve territory prices, refuse a free trial with prices and are idempotent', async () => {
  const f = shop({ '/v1/subscriptions/sub1/promotionalOffers': [] });
  const input = { ...base, subscriptionId: 'sub1', name: 'Win back', offerCode: 'winback1', offerMode: 'PAY_AS_YOU_GO', duration: 'ONE_MONTH', numberOfPeriods: 3, prices: x.parsePrices('USA=0.99,TUR=29.99') };
  assert.equal((await x.createPromotionalOffer(input, f.api)).dryRun, true);
  assert.equal(f.writes().length, 0);
  assert.equal((await x.createPromotionalOffer({ ...input, execute: true }, f.api) as { status?: string }).status, 'created');
  const body = f.writes()[0]!.body as any;
  assert.deepEqual(body.included.map((p: any) => [p.relationships.territory.data.id, p.relationships.subscriptionPricePoint.data.id]), [['USA', 's-usa'], ['TUR', 's-tur']]);
  assert.deepEqual(body.data.relationships.prices.data.map((p: any) => p.id), body.included.map((p: any) => p.id));
  await assert.rejects(x.createPromotionalOffer({ ...input, offerMode: 'FREE_TRIAL' }, f.api), /takes no --prices/);
  await assert.rejects(x.createPromotionalOffer({ ...input, prices: [] }, f.api), /need --prices/);
  assert.throws(() => x.parsePrices('USA=0.99,USA=1.99'), /once/);
  assert.throws(() => x.parsePrices('usa:1'), /Invalid price/);
  const exists = shop({ '/v1/subscriptions/sub1/promotionalOffers': [res('po', 'subscriptionPromotionalOffers', { offerCode: 'winback1' })] });
  assert.equal((await x.createPromotionalOffer({ ...input, execute: true }, exists.api) as { status?: string }).status, 'exists');
  assert.deepEqual(await x.deletePromotionalOffer({ ...base, subscriptionId: 'sub1', offerId: 'po' }, exists.api), { removed: 'po' });
  await assert.rejects(x.deletePromotionalOffer({ ...base, subscriptionId: 'sub1', offerId: 'nope' }, exists.api), /does not belong/);
});
test('offer codes validate per product kind and build valid requests', async () => {
  const f = shop({ '/v1/subscriptions/sub1/offerCodes': [], '/v2/inAppPurchases/iap1/offerCodes': [] });
  const sub = { ...base, kind: 'subscription' as const, productId: 'sub1', name: 'Spring', eligibility: ['NEW', 'EXPIRED'], offerEligibility: 'STACK_WITH_INTRO_OFFERS', offerMode: 'FREE_TRIAL', duration: 'ONE_MONTH', numberOfPeriods: 1, prices: [], execute: true };
  assert.equal((await x.createOfferCode(sub, f.api) as { status?: string }).status, 'created');
  const iap = { ...base, kind: 'iap' as const, productId: 'iap1', name: 'Coins', eligibility: ['NON_SPENDER'], prices: x.parsePrices('USA=0.99'), execute: true };
  await x.createOfferCode(iap, f.api);
  assert.equal((f.writes()[1]!.body as any).included[0].relationships.pricePoint.data.id, 'i-usa');
  await assert.rejects(x.createOfferCode({ ...iap, eligibility: ['NEW'] }, f.api), /Eligibility must use NON_SPENDER/);
  await assert.rejects(x.createOfferCode({ ...iap, offerMode: 'FREE_TRIAL' }, f.api), /apply only to subscriptions/);
  await assert.rejects(x.createOfferCode({ ...sub, offerEligibility: undefined }, f.api), /--offer-eligibility/);
});
test('offer code activation, custom codes and one-time code files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codes-')); const out = join(dir, 'codes.csv');
  const f = shop({ '/v1/subscriptions/sub1/offerCodes': [res('oc', 'subscriptionOfferCodes', { active: true, name: 'Spring' })], '/v1/subscriptionOfferCodes/oc/customCodes': [res('cc', 'x', { customCode: 'TAKEN' })] });
  const downloads: string[] = [];
  const api = { ...f.api, download: async (path: string, accept: string) => { assertContract('GET', path); downloads.push(`${accept} ${path}`); return Buffer.from('code\nAAA\nBBB\n'); } };
  const code = { ...base, kind: 'subscription' as const, productId: 'sub1', offerCodeId: 'oc' };
  try {
    assert.equal((await x.setOfferCodeActive({ ...code, active: true }, api)).status, 'unchanged');
    assert.equal((await x.setOfferCodeActive({ ...code, active: false }, api)).status, 'updated');
    assert.equal((await x.createCustomCode({ ...code, customCode: 'TAKEN', count: 10 }, api)).status, 'exists');
    assert.equal((await x.createCustomCode({ ...code, customCode: 'SPRING25', count: 10, expires: '2027-06-01' }, api)).status, 'created');
    await assert.rejects(x.createCustomCode({ ...code, customCode: 'lower', count: 10 }, api), /uppercase/);
    const gen = { ...code, count: 2, expires: '2099-01-01', out };
    assert.equal((await x.generateOneTimeCodes(gen, api)).dryRun, true);
    assert.equal(downloads.length, 0);
    const done = await x.generateOneTimeCodes({ ...gen, execute: true }, api);
    assert.equal(readFileSync(out, 'utf8'), 'code\nAAA\nBBB\n');
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.match(downloads[0]!, /^text\/csv \/v1\/subscriptionOfferCodeOneTimeUseCodes\/.+\/values$/);
    assert.ok((done as { batchId?: string }).batchId);
    await assert.rejects(x.generateOneTimeCodes({ ...gen, expires: '2001-01-01' }, api), /future date/);
    await assert.rejects(x.generateOneTimeCodes({ ...gen, offerCodeId: 'other' }, api), /does not belong/);
    const failing = { ...api, download: async () => { throw new AppleError(500, []); } };
    await assert.rejects(x.generateOneTimeCodes({ ...gen, out: join(dir, 'b.csv'), execute: true }, failing), /was created; download its values/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('promoted purchases are created once, updated in place and removed only for this app', async () => {
  const f = shop({ '/v1/apps/123/promotedPurchases': [res('pp', 'promotedPurchases', { visibleForAllUsers: true, enabled: true }, { subscription: { data: { id: 'sub1', type: 'subscriptions' } } })] });
  assert.equal((await x.setPromotedPurchase({ ...base, kind: 'subscription', productId: 'sub1', enabled: true }, f.api)).status, 'unchanged');
  assert.equal((await x.setPromotedPurchase({ ...base, kind: 'subscription', productId: 'sub1', enabled: false }, f.api)).status, 'updated');
  assert.equal((await x.setPromotedPurchase({ ...base, kind: 'iap', productId: 'iap1' }, f.api)).status, 'created');
  assert.equal((f.writes().at(-1)!.body as any).data.relationships.inAppPurchaseV2.data.id, 'iap1');
  assert.deepEqual(await x.deletePromotedPurchase({ ...base, promotedPurchaseId: 'pp' }, f.api), { removed: 'pp' });
  await assert.rejects(x.deletePromotedPurchase({ ...base, promotedPurchaseId: 'zz' }, f.api), /does not belong/);
});
test('product review screenshot uploads, commits an MD5 and replaces the previous one afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-')); const filePath = join(dir, 's.png'); const bytes = png(10, 10); writeFileSync(filePath, bytes);
  const ops = [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: bytes.length, requestHeaders: [] }];
  const f = fakeApi({ '/v1/apps/123/inAppPurchasesV2': [res('iap1', 'inAppPurchases')], '/v2/inAppPurchases/iap1/appStoreReviewScreenshot': res('old', 'x', { sourceFileChecksum: 'abc' }) },
    { post: () => res('newshot', 'inAppPurchaseAppStoreReviewScreenshots', { uploadOperations: ops }) });
  const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
  try {
    const result = await x.uploadProductReviewScreenshot({ ...base, kind: 'iap', productId: 'iap1', filePath }, f.api, fetcher);
    assert.equal(result.status, 'uploaded'); assert.equal((result as { replaced?: string }).replaced, 'old');
    assert.deepEqual(f.writes().map(w => w.method), ['POST', 'PATCH', 'DELETE']);
    let posts = 0;
    const refusing = fakeApi({ '/v1/apps/123/inAppPurchasesV2': [res('iap1', 'x')], '/v2/inAppPurchases/iap1/appStoreReviewScreenshot': res('old', 'x') },
      { post: () => { if (++posts === 1) throw new AppleError(409, []); return res('n2', 'inAppPurchaseAppStoreReviewScreenshots', { uploadOperations: ops }); } });
    await x.uploadProductReviewScreenshot({ ...base, kind: 'iap', productId: 'iap1', filePath }, refusing.api, fetcher);
    assert.deepEqual(refusing.writes().map(w => w.method), ['POST', 'DELETE', 'POST', 'PATCH']);
  } finally { rmSync(dir, { recursive: true }); }
});
