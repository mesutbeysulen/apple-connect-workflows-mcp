import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createIap, createSubscription, createSubscriptionGroup, createProductVersion, localizeProduct, localizeProductVersion, setAppPrice, setIapPrice, setSubscriptionPrice } from '../src/commercial.js';
import { downloadSales, downloadAnalytics, requestAnalytics, ReportSpool, reportPeriods } from '../src/reports.js';
import { AppleError } from '../src/apple.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const shop = (over = {}) => ({
  '/v1/apps/123/inAppPurchasesV2': [res('iap1', 'inAppPurchases', { productId: 'coins' })],
  '/v1/apps/123/subscriptionGroups': [res('g1', 'subscriptionGroups', { referenceName: 'Pro' })],
  '/v1/subscriptionGroups/g1/subscriptions': [res('sub1', 'subscriptions', { productId: 'pro.month' })],
  '/v2/inAppPurchases/iap1/inAppPurchaseLocalizations': [res('l1', 'inAppPurchaseLocalizations', { locale: 'tr', name: 'Altın', description: 'd' })],
  '/v1/subscriptions/sub1/subscriptionLocalizations': [],
  '/v1/apps/123/appPricePoints': [res('app-499', 'appPricePoints', { customerPrice: '4.99' }), res('app-599', 'appPricePoints', { customerPrice: '5.99' })],
  '/v2/inAppPurchases/iap1/pricePoints': [res('iap-199', 'inAppPurchasePricePoints', { customerPrice: '1.99' })],
  '/v1/subscriptions/sub1/pricePoints': [res('sub-999', 'subscriptionPricePoints', { customerPrice: '9.99' })],
  ...over,
}) as never;
test('product creation is idempotent and validated', async () => {
  const f = fakeApi(shop());
  assert.deepEqual(await createIap({ account, appId: '123', productId: 'coins', name: 'Coins', type: 'CONSUMABLE' }, f.api), { status: 'exists', id: 'iap1' });
  assert.equal((await createIap({ account, appId: '123', productId: 'gems', name: 'Gems', type: 'CONSUMABLE' }, f.api)).status, 'created');
  assert.equal(f.writes()[0]!.path, '/v2/inAppPurchases');
  await assert.rejects(createIap({ account, appId: '123', productId: 'x', name: 'X', type: 'BOGUS' }, f.api), /type of/);
  await assert.rejects(createIap({ account: readOnly, appId: '123', productId: 'x', name: 'X', type: 'CONSUMABLE' }, f.api), /read-only/);
  assert.equal((await createSubscriptionGroup({ account, appId: '123', referenceName: 'Pro' }, f.api)).status, 'exists');
  assert.equal((await createSubscription({ account, appId: '123', groupId: 'g1', productId: 'pro.month', name: 'Pro', period: 'ONE_MONTH' }, f.api)).status, 'exists');
  await assert.rejects(createSubscription({ account, appId: '123', groupId: 'g1', productId: 'p', name: 'P', period: 'ONE_MONTH', groupLevel: NaN }, f.api), /positive integer/);
  await assert.rejects(createSubscription({ account, appId: '123', groupId: 'other', productId: 'p', name: 'P', period: 'ONE_MONTH' }, f.api), /does not belong/);
  assert.equal(f.writes().length, 1);
});
test('localization creates, updates or leaves unchanged', async () => {
  const f = fakeApi(shop());
  const base = { account, appId: '123', kind: 'iap' as const, productId: 'iap1', locale: 'tr' };
  assert.equal((await localizeProduct({ ...base, name: 'Altın' }, f.api)).status, 'unchanged');
  assert.equal(f.writes().length, 0);
  assert.equal((await localizeProduct({ ...base, name: 'Para' }, f.api)).status, 'updated');
  assert.equal(f.writes()[0]!.path, '/v2/inAppPurchaseLocalizations/l1');
  assert.equal((await localizeProduct({ account, appId: '123', kind: 'subscription', productId: 'sub1', locale: 'en-US', name: 'Pro' }, f.api)).status, 'created');
  assert.equal(f.writes()[1]!.path, '/v1/subscriptionLocalizations');
  await assert.rejects(localizeProduct({ ...base, productId: 'stranger', name: 'x' }, f.api), /does not belong/);
});
test('product metadata versions are app-owned, idempotent and localized with v2 relationships', async () => {
  const versions = shop({
    '/v2/inAppPurchases/iap1/versions': [res('iv', 'inAppPurchaseVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
    '/v1/subscriptions/sub1/versions': [],
    '/v1/subscriptionGroups/g1/versions': [res('gv', 'subscriptionGroupVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
    '/v1/inAppPurchaseVersions/iv/localizations': [res('loc', 'inAppPurchaseLocalizations', { locale: 'en-US', name: 'Coins' })],
    '/v1/subscriptionGroupVersions/gv/localizations': [],
  });
  const f = fakeApi(versions);
  const base = { account, appId: '123' };
  assert.deepEqual(await createProductVersion({ ...base, kind: 'iap', productId: 'iap1' }, f.api), { status: 'exists', id: 'iv' });
  assert.equal((await createProductVersion({ ...base, kind: 'subscription', productId: 'sub1' }, f.api)).status, 'created');
  assert.equal((f.writes()[0]!.body as any).data.relationships.subscription.data.id, 'sub1');
  assert.equal((await localizeProductVersion({ ...base, kind: 'iap', productId: 'iap1', versionId: 'iv', locale: 'en-US', name: 'Coins' }, f.api)).status, 'unchanged');
  assert.equal((await localizeProductVersion({ ...base, kind: 'iap', productId: 'iap1', versionId: 'iv', locale: 'en-US', name: 'Gold' }, f.api)).status, 'updated');
  assert.equal(f.writes()[1]!.path, '/v2/inAppPurchaseLocalizations/loc');
  assert.equal((await localizeProductVersion({ ...base, kind: 'subscription-group', productId: 'g1', versionId: 'gv', locale: 'en-US', name: 'Pro' }, f.api)).status, 'created');
  assert.equal((f.writes()[2]!.body as any).data.relationships.version.data.id, 'gv');
  await assert.rejects(localizeProductVersion({ ...base, kind: 'iap', productId: 'iap1', versionId: 'foreign', locale: 'en-US', name: 'X' }, f.api), /does not belong/);
  await assert.rejects(createProductVersion({ ...base, kind: 'iap', productId: 'foreign' }, f.api), /does not belong/);
  assert.equal(f.writes().length, 3);
});
test('prices preview by default, match exactly and write only with execute', async () => {
  const f = fakeApi(shop());
  const preview = await setAppPrice({ account: readOnly, appId: '123', territory: 'USA', price: '4.99' }, f.api);
  assert.equal(preview.dryRun, true); assert.equal(preview.pricePointId, 'app-499'); assert.equal(f.writes().length, 0);
  await assert.rejects(setAppPrice({ account, appId: '123', territory: 'USA', price: '5.00' }, f.api), /No USA price point equals 5\.00\. Closest: 4\.99, 5\.99/);
  await assert.rejects(setAppPrice({ account: readOnly, appId: '123', territory: 'USA', price: '4.99', execute: true }, f.api), /read-only/);
  await setAppPrice({ account, appId: '123', territory: 'USA', price: '4.99', execute: true }, f.api);
  const app = f.writes()[0]!.body as any;
  assert.equal(app.included[0].relationships.appPricePoint.data.id, 'app-499');
  assert.equal(app.data.relationships.manualPrices.data[0].id, app.included[0].id);
  await setIapPrice({ account, appId: '123', iapId: 'iap1', territory: 'USA', price: '1.99', startDate: '2027-01-01', execute: true }, f.api);
  const iap = f.writes()[1]!.body as any;
  assert.equal(iap.included[0].attributes.startDate, '2027-01-01');
  assert.equal(iap.included[0].relationships.inAppPurchasePricePoint.data.id, 'iap-199');
  await setSubscriptionPrice({ account, appId: '123', subscriptionId: 'sub1', territory: 'USA', price: '9.99', preserveCurrentPrice: true, execute: true }, f.api);
  const sub = f.writes()[2]!.body as any;
  assert.equal(sub.data.attributes.preserveCurrentPrice, true);
  assert.equal(sub.data.relationships.subscriptionPricePoint.data.id, 'sub-999');
  await assert.rejects(setIapPrice({ account, appId: '123', iapId: 'stranger', territory: 'USA', price: '1.99' }, f.api), /does not belong/);
  await assert.rejects(setAppPrice({ account, appId: '123', territory: 'usa', price: '1' }, f.api), /territory/);
});
test('price output records what it replaces, and subscription retries do not duplicate', async () => {
  const f = fakeApi(shop({
    '/v1/apps/123/appPriceSchedule': res('sch', 'appPriceSchedules'),
    '/v1/appPriceSchedules/sch/manualPrices': [res('mp', 'appPrices', { manual: true, startDate: '2026-01-01' }, { territory: { data: { id: 'TUR', type: 'territories' } }, appPricePoint: { data: { id: 'old-point', type: 'appPricePoints' } } })],
    '/v1/subscriptions/sub1/prices': [res('sp', 'subscriptionPrices', { startDate: '2027-01-01' }, { subscriptionPricePoint: { data: { id: 'sub-999', type: 'subscriptionPricePoints' } } })],
  }));
  const preview = await setAppPrice({ account: readOnly, appId: '123', territory: 'USA', price: '4.99' }, f.api);
  assert.deepEqual(preview.current, [{ id: 'mp', manual: true, startDate: '2026-01-01', endDate: null, territory: 'TUR', pricePointId: 'old-point' }]);
  const none = await setIapPrice({ account: readOnly, appId: '123', iapId: 'iap1', territory: 'USA', price: '1.99' }, f.api);
  assert.deepEqual(none.current, []);
  const again = await setSubscriptionPrice({ account, appId: '123', subscriptionId: 'sub1', territory: 'USA', price: '9.99', startDate: '2027-01-01', execute: true }, f.api);
  assert.equal(again.status, 'exists'); assert.equal(again.result, 'sp');
  assert.equal(f.writes().length, 0);
  assert.equal((await setSubscriptionPrice({ account, appId: '123', subscriptionId: 'sub1', territory: 'USA', price: '9.99', startDate: '2027-02-01', execute: true }, f.api)).status, 'created');
  assert.equal(f.writes().length, 1);
});
test('merges reports with differing columns and drops footers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-')); const out = join(dir, 'm.tsv');
  const spool = await ReportSpool.open(out, 'period');
  try {
    await spool.add('d1', Buffer.from('A\tB\n1\t2\nTotal_Rows\n'));
    await spool.add('d2', gzipSync('B\tC\n3\t4\n'));
    await spool.add('empty', Buffer.from(''));
    assert.equal(await spool.write(out), 2);
    assert.equal(readFileSync(out, 'utf8'), 'period\tA\tB\tC\nd1\t1\t2\t\nd2\t\t3\t4\n');
    await spool.close();
    assert.deepEqual(readdirSync(dir), ['m.tsv']);
  } finally { rmSync(dir, { recursive: true }); }
});
test('report periods follow the frequency and are bounded', () => {
  assert.deepEqual(reportPeriods('DAILY', '2026-01-30', '2026-02-01'), ['2026-01-30', '2026-01-31', '2026-02-01']);
  assert.deepEqual(reportPeriods('MONTHLY', '2026-01-30', '2026-03-01'), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(reportPeriods('YEARLY', '2025-12-31', '2026-01-01'), ['2025', '2026']);
  assert.deepEqual(reportPeriods('WEEKLY', '2026-11-01', '2026-11-08'), ['2026-11-01', '2026-11-08']);
  assert.throws(() => reportPeriods('WEEKLY', '2026-11-02', '2026-11-03'), /no report period/);
  assert.throws(() => reportPeriods('DAILY', '2020-01-01', '2026-01-01'), /400/);
  assert.throws(() => reportPeriods('DAILY', '2026-02-01', '2026-01-01'), /must not be after/);
});
test('sales download merges days, records missing periods and fails on real errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sales-')); const out = join(dir, 'sales.tsv');
  const paths: string[] = [];
  const api = { ...fakeApi({}).api, download: async (path: string) => { paths.push(path);
    if (path.includes('2026-01-02')) throw new AppleError(404, []);
    if (path.includes('2026-02-02')) throw new AppleError(403, []);
    return gzipSync('SKU\tUnits\ncoins\t3\n'); } };
  const input = { vendorNumber: '85', reportType: 'SALES', reportSubType: 'SUMMARY', frequency: 'DAILY', from: '2026-01-01', to: '2026-01-02', out };
  try {
    const result = await downloadSales(input, api);
    assert.deepEqual(result.missing, ['2026-01-02']); assert.equal(result.rows, 1);
    assert.equal(readFileSync(out, 'utf8'), 'report_period\tSKU\tUnits\n2026-01-01\tcoins\t3\n');
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert(paths[0]!.includes('filter%5BvendorNumber%5D=85'));
    await assert.rejects(downloadSales({ ...input, from: '2026-02-02', to: '2026-02-02' }, api), /403/);
    // Earlier days survive a later failure in a separate file, and the real output stays intact.
    const before = readFileSync(out, 'utf8');
    await assert.rejects(downloadSales({ ...input, from: '2026-02-01', to: '2026-02-02' }, api), /1 earlier period\(s\) saved/);
    assert.match(readFileSync(`${out}.partial`, 'utf8'), /2026-02-01\tcoins\t3/);
    assert.equal(readFileSync(out, 'utf8'), before);
    // A range Apple has not published must not overwrite an earlier file.
    const none = await downloadSales({ ...input, from: '2026-01-02', to: '2026-01-02' }, api);
    assert.equal(none.out, null); assert.equal(none.rows, 0);
    assert.equal(readFileSync(out, 'utf8'), before);
    assert.deepEqual(readdirSync(dir).sort(), ['sales.tsv', 'sales.tsv.partial']);
    await assert.rejects(downloadSales({ ...input, out: 'relative.tsv' }, api), /absolute/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('overlapping report requests do not double count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-')); const out = join(dir, 'a.tsv');
  const body = gzipSync('Date\tCount\n2026-01-01\t5\n');
  const f = fakeApi({
    '/v1/apps/123/analyticsReportRequests': [res('snap', 'analyticsReportRequests', { accessType: 'ONE_TIME_SNAPSHOT' }), res('live', 'analyticsReportRequests', { accessType: 'ONGOING' })],
    '/v1/analyticsReportRequests/snap/reports': [res('r1', 'analyticsReports', { name: 'Downloads' })],
    '/v1/analyticsReportRequests/live/reports': [res('r2', 'analyticsReports', { name: 'Downloads' })],
    '/v1/analyticsReports/r1/instances': [res('i1', 'x', { processingDate: '2026-01-01' }), res('old', 'x', { processingDate: '2025-06-01' })],
    '/v1/analyticsReports/r2/instances': [res('i2', 'x', { processingDate: '2026-01-01' })],
    '/v1/analyticsReportInstances/i1/segments': [res('s1', 'x', { url: 'https://a.apple.com/1' })],
    '/v1/analyticsReportInstances/i2/segments': [res('s2', 'x', { url: 'https://a.apple.com/2' })],
    '/v1/analyticsReportInstances/old/segments': [res('s3', 'x', { url: 'https://a.apple.com/3' })],
  });
  const fetcher = (async () => new Response(body)) as unknown as typeof fetch;
  try {
    const result = await downloadAnalytics({ appId: '123', reportName: 'Downloads', granularity: 'DAILY', out }, { ...f.api, download: async () => Buffer.alloc(0) }, fetcher);
    assert.deepEqual(result.instances, ['i2', 'old']);
    assert.equal(result.overlappingInstancesSkipped, 1);
    assert.equal(result.rows, 2);
  } finally { rmSync(dir, { recursive: true }); }
});
test('analytics downloads verify checksums, send no credentials and filter by date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-')); const out = join(dir, 'a.tsv');
  const body = gzipSync('Date\tCount\n2026-01-01\t5\n');
  let checksum = createHash('md5').update(body).digest('hex');
  const f = fakeApi({
    '/v1/apps/123/analyticsReportRequests': [res('req', 'analyticsReportRequests', { accessType: 'ONGOING' })],
    '/v1/analyticsReportRequests/req/reports': [res('rep', 'analyticsReports', { name: 'Downloads' })],
    '/v1/analyticsReports/rep/instances': [res('i1', 'analyticsReportInstances', { processingDate: '2026-01-01' }), res('i2', 'analyticsReportInstances', { processingDate: '2025-01-01' })],
    '/v1/analyticsReportInstances/i1/segments': () => [res('seg', 'analyticsReportSegments', { url: 'https://example.apple.com/seg?sig=1', checksum })],
  });
  const api = { ...f.api, download: async () => Buffer.alloc(0) };
  const fetcher = (async (_u: URL, init: RequestInit) => { assert.equal(new Headers(init.headers).has('authorization'), false); return new Response(body); }) as unknown as typeof fetch;
  const input = { appId: '123', reportName: 'Downloads', granularity: 'DAILY', from: '2026-01-01', out };
  try {
    const result = await downloadAnalytics(input, api, fetcher);
    assert.equal(result.rows, 1); assert.deepEqual(result.instances, ['i1']);
    assert.match(readFileSync(out, 'utf8'), /^processing_date\tDate\tCount\n2026-01-01\t2026-01-01\t5\n$/);
    checksum = 'bad';
    await assert.rejects(downloadAnalytics(input, api, fetcher), /checksum/);
    assert.equal((await requestAnalytics({ account, appId: '123', accessType: 'ONGOING' }, api)).status, 'exists');
    assert.equal(f.writes().length, 0);
    assert.equal((await requestAnalytics({ account, appId: '123', accessType: 'ONE_TIME_SNAPSHOT' }, api)).status, 'created');
  } finally { rmSync(dir, { recursive: true }); }
});
