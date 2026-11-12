import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { setIntroOffer, deleteIntroOffer } from '../src/offers.js';
import { downloadFinance } from '../src/reports.js';
import { AppleError } from '../src/apple.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const point = (id: string) => ({ subscriptionPricePoint: { data: { id, type: 'subscriptionPricePoints' } } });
const shop = (offers: unknown[] = []) => fakeApi({
  '/v1/apps/123/subscriptionGroups': [res('g1', 'subscriptionGroups')],
  '/v1/subscriptionGroups/g1/subscriptions': [res('sub1', 'subscriptions')],
  '/v1/subscriptions/sub1/pricePoints': [res('p099', 'subscriptionPricePoints', { customerPrice: '0.99' })],
  '/v1/subscriptions/sub1/introductoryOffers': offers as never,
});
const base = { account, appId: '123', subscriptionId: 'sub1', territory: 'USA' };
const trial = { ...base, offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK', numberOfPeriods: 1 };

test('a free trial previews first, then is created without a price point', async () => {
  const f = shop();
  const preview = await setIntroOffer({ ...trial, account: readOnly }, f.api);
  assert.equal(preview.dryRun, true); assert.equal(f.writes().length, 0);
  const created = await setIntroOffer({ ...trial, execute: true }, f.api);
  assert.equal(created.status, 'created');
  const body = f.writes()[0]!.body as any;
  assert.deepEqual(body.data.attributes, { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK', numberOfPeriods: 1 });
  assert.equal(body.data.relationships.territory.data.id, 'USA');
  assert.equal(body.data.relationships.subscriptionPricePoint, undefined);
  await assert.rejects(setIntroOffer({ ...trial, account: readOnly, execute: true }, f.api), /read-only/);
});
test('paid offers match an exact price point; free trials refuse a price', async () => {
  const f = shop();
  await setIntroOffer({ ...base, offerMode: 'PAY_UP_FRONT', duration: 'ONE_MONTH', numberOfPeriods: 1, price: '0.99', startDate: '2027-01-01', execute: true }, f.api);
  assert.equal((f.writes()[0]!.body as any).data.relationships.subscriptionPricePoint.data.id, 'p099');
  await assert.rejects(setIntroOffer({ ...base, offerMode: 'PAY_AS_YOU_GO', duration: 'ONE_MONTH', numberOfPeriods: 3 }, f.api), /need --price/);
  await assert.rejects(setIntroOffer({ ...trial, price: '0.99' }, f.api), /takes no --price/);
  await assert.rejects(setIntroOffer({ ...base, offerMode: 'PAY_UP_FRONT', duration: 'ONE_MONTH', numberOfPeriods: 1, price: '1.00' }, f.api), /No USA price point/);
  await assert.rejects(setIntroOffer({ ...trial, duration: 'FOREVER' }, f.api), /Duration/);
  await assert.rejects(setIntroOffer({ ...trial, numberOfPeriods: 0 }, f.api), /1 to 12/);
  await assert.rejects(setIntroOffer({ ...trial, startDate: '2027-02-01', endDate: '2027-01-01' }, f.api), /after the start/);
  await assert.rejects(setIntroOffer({ ...trial, subscriptionId: 'stranger' }, f.api), /does not belong/);
  assert.equal(f.writes().length, 1);
});
test('an identical offer is left alone and a different one needs replace', async () => {
  const same = shop([res('o1', 'subscriptionIntroductoryOffers', { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK', numberOfPeriods: 1 })]);
  assert.deepEqual(await setIntroOffer({ ...trial, execute: true }, same.api).then(r => [r.status, (r as { offerId?: string }).offerId]), ['exists', 'o1']);
  assert.equal(same.writes().length, 0);
  const other = () => shop([res('o2', 'subscriptionIntroductoryOffers', { offerMode: 'PAY_UP_FRONT', duration: 'ONE_MONTH', numberOfPeriods: 1 }, point('p099'))]);
  const blocked = other();
  assert.match((await setIntroOffer(trial, blocked.api)).effect, /--replace/);
  await assert.rejects(setIntroOffer({ ...trial, execute: true }, blocked.api), /--replace/);
  assert.equal(blocked.writes().length, 0);
  const swap = other();
  const result = await setIntroOffer({ ...trial, replace: true, execute: true }, swap.api);
  assert.deepEqual(swap.writes().map(w => w.method), ['DELETE', 'POST']);
  assert.deepEqual((result as { removed?: string[] }).removed, ['o2']);
});
test('deleting an offer checks it belongs to the subscription', async () => {
  const f = shop([res('o1', 'subscriptionIntroductoryOffers')]);
  assert.deepEqual(await deleteIntroOffer({ ...base, offerId: 'o1' }, f.api), { removed: 'o1' });
  await assert.rejects(deleteIntroOffer({ ...base, offerId: 'nope' }, f.api), /does not belong/);
  await assert.rejects(deleteIntroOffer({ ...base, account: readOnly, offerId: 'o1' }, f.api), /read-only/);
  assert.equal(f.writes().length, 1);
});
test('finance download merges fiscal months, lists missing ones and validates input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finance-')); const out = join(dir, 'f.tsv');
  const paths: string[] = [];
  const api = { ...fakeApi({}).api, download: async (path: string) => {
    paths.push(path);
    if (path.includes('2026-02')) throw new AppleError(404, []);
    return gzipSync('Start Date\tUnits\n10/01/2026\t3\n');
  } };
  const input = { vendorNumber: '85', reportType: 'FINANCIAL', regionCode: 'ZZ', from: '2026-01', to: '2026-03', out };
  try {
    const result = await downloadFinance(input, api);
    assert.deepEqual(result.downloaded, ['2026-01', '2026-03']); assert.deepEqual(result.missing, ['2026-02']); assert.equal(result.rows, 2);
    assert.match(readFileSync(out, 'utf8'), /^fiscal_month\tStart Date\tUnits\n2026-01\t/);
    assert(paths[0]!.startsWith('/v1/financeReports?') && paths[0]!.includes('filter%5BregionCode%5D=ZZ'));
    const none = await downloadFinance({ ...input, from: '2026-02', to: '2026-02' }, api);
    assert.equal(none.out, null);
    await assert.rejects(downloadFinance({ ...input, reportType: 'SALES' }, api), /FINANCIAL or FINANCE_DETAIL/);
    await assert.rejects(downloadFinance({ ...input, from: '2026-1' }, api), /YYYY-MM/);
    await assert.rejects(downloadFinance({ ...input, regionCode: 'zz' }, api), /Region code/);
    assert.deepEqual(readdirSync(dir), ['f.tsv']);
  } finally { rmSync(dir, { recursive: true }); }
});
