import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseReadiness, submitRelease, publishRelease, manualCheckIds } from '../src/release.js';
import { submitForReview } from '../src/review.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const good = (over: Record<string, unknown> = {}) => ({
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION', versionString: '1.2.0', copyright: '2026 X', platform: 'IOS' }, { app: { data: { id: '123', type: 'apps' } } }),
  '/v1/appStoreVersions/v/build': res('b', 'builds', { processingState: 'VALID', expired: false, usesNonExemptEncryption: false }),
  '/v1/apps/123/appStoreVersions': [res('v', 'appStoreVersions'), res('old', 'appStoreVersions', { appStoreState: 'READY_FOR_SALE' })],
  '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'appStoreVersionLocalizations', { locale: 'tr', description: 'd', keywords: 'k', supportUrl: 'https://x', whatsNew: 'n' })],
  '/v1/appStoreVersionLocalizations/loc/placements': [res('s', 'appAssetLibraryPlacements', { placementType: 'APP_SCREENSHOT' })],
  '/v1/appStoreVersions/v/appStoreReviewDetail': res('r', 'appStoreReviewDetails', { contactFirstName: 'A', contactLastName: 'B', contactPhone: '+1', contactEmail: 'a@x' }),
  '/v1/apps/123': res('123', 'apps', { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' }),
  '/v1/apps/123/appInfos': [res('i', 'appInfos', { state: 'PREPARE_FOR_SUBMISSION' })],
  '/v1/appInfos/i/primaryCategory': res('GAMES', 'appCategories'),
  '/v1/appInfos/i/ageRatingDeclaration': res('a', 'ageRatingDeclarations', { violenceCartoonOrFantasy: 'NONE' }),
  '/v1/appInfos/i/appInfoLocalizations': [res('il', 'appInfoLocalizations', { locale: 'tr', name: 'App', privacyPolicyUrl: 'https://p' })],
  '/v1/apps/123/appPriceSchedule': res('p', 'appPriceSchedules'),
  '/v1/apps/123/appAvailabilityV2': res('av', 'appAvailabilities'),
  ...over,
}) as never;
test('automated checks alone cannot certify a release; explicit manual checks can', async () => {
  const report = await releaseReadiness(fakeApi(good()).api, '123', 'v');
  assert.deepEqual(report.blockers, []); assert.equal(report.automatedReady, true); assert.equal(report.ready, false);
  assert(report.notChecked.some(n => /Privacy/.test(n)));
  const attested = await releaseReadiness(fakeApi(good()).api, '123', 'v', manualCheckIds);
  assert.equal(attested.ready, true); assert.deepEqual(attested.notChecked, []);
  await assert.rejects(releaseReadiness(fakeApi(good()).api, '123', 'v', ['invented' as never]), /Unknown manual check/);
});
test('reports every missing field as a blocker', async () => {
  const f = fakeApi(good({
    '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION', versionString: '1.2.0' }, { app: { data: { id: '123', type: 'apps' } } }),
    '/v1/appStoreVersions/v/build': undefined,
    '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'x', { locale: 'tr', description: ' ', supportUrl: 'https://x' })],
    '/v1/appStoreVersionLocalizations/loc/placements': [],
    '/v1/appStoreVersions/v/appStoreReviewDetail': undefined,
    '/v1/apps/123': res('123', 'apps'),
    '/v1/appInfos/i/primaryCategory': undefined,
    '/v1/appInfos/i/ageRatingDeclaration': res('a', 'x', { violenceCartoonOrFantasy: null }),
    '/v1/appInfos/i/appInfoLocalizations': [res('il', 'x', { locale: 'tr', name: 'App' })],
    '/v1/apps/123/appPriceSchedule': undefined,
  }));
  const { blockers, ready } = await releaseReadiness(f.api, '123', 'v');
  assert.equal(ready, false);
  for (const expected of [/copyright/, /No build/, /tr: description/, /tr: keywords/, /tr: release notes/, /tr: no screenshots/, /Review contact/, /Content rights/, /Primary category/, /Age rating/, /privacy policy/, /price schedule/]) assert(blockers.some(b => expected.test(b)), String(expected));
  assert.equal(f.writes().length, 0);
});
test('build problems block; first release does not need notes; legacy screenshots count', async () => {
  const unprocessed = await releaseReadiness(fakeApi(good({ '/v1/appStoreVersions/v/build': res('b', 'builds', { processingState: 'PROCESSING' }) })).api, '123', 'v');
  assert(unprocessed.blockers.some(b => /not VALID/.test(b)) && unprocessed.blockers.some(b => /export compliance/.test(b)));
  const first = await releaseReadiness(fakeApi(good({ '/v1/apps/123/appStoreVersions': [res('v', 'x')],
    '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'x', { locale: 'tr', description: 'd', keywords: 'k', supportUrl: 'https://x' })],
    '/v1/appStoreVersionLocalizations/loc/placements': [],
    '/v1/appStoreVersionLocalizations/loc/appScreenshotSets': [res('set', 'appScreenshotSets')], '/v1/appScreenshotSets/set/appScreenshots': [res('s', 'appScreenshots', { assetDeliveryState: { state: 'COMPLETE' } })] })).api, '123', 'v');
  assert.deepEqual(first.blockers, []); assert.equal(first.automatedReady, true);
  await assert.rejects(releaseReadiness(fakeApi(good({ '/v1/appStoreVersions/v': res('v', 'appStoreVersions', {}, { app: { data: { id: '999', type: 'apps' } } }) })).api, '123', 'v'), /does not belong/);
});
test('non-exempt encryption needs an approved declaration attached to the build', async () => {
  const encrypted = good({ '/v1/appStoreVersions/v/build': res('b', 'builds', { processingState: 'VALID', expired: false, usesNonExemptEncryption: true }) });
  const absent = await releaseReadiness(fakeApi(encrypted).api, '123', 'v', manualCheckIds);
  assert(absent.blockers.some(b => /no attached declaration/.test(b)));
  const pending = await releaseReadiness(fakeApi({ ...encrypted, '/v1/builds/b/appEncryptionDeclaration': res('d', 'appEncryptionDeclarations', { appEncryptionDeclarationState: 'IN_REVIEW' }) }).api, '123', 'v', manualCheckIds);
  assert(pending.blockers.some(b => /not APPROVED/.test(b)));
  const approved = await releaseReadiness(fakeApi({ ...encrypted, '/v1/builds/b/appEncryptionDeclaration': res('d', 'appEncryptionDeclarations', { appEncryptionDeclarationState: 'APPROVED' }) }).api, '123', 'v', manualCheckIds);
  assert.equal(approved.ready, true);
});
test('failed placements and abandoned reservations are not screenshots; incomplete lists block', async () => {
  const failed = await releaseReadiness(fakeApi(good({ '/v1/appStoreVersionLocalizations/loc/placements': [res('s', 'p', { placementType: 'APP_SCREENSHOT', state: 'FAILED' })] })).api, '123', 'v');
  assert(failed.blockers.some(b => /tr: no screenshots/.test(b))); assert(failed.warnings.some(w => /failed processing/.test(w)));
  const abandoned = await releaseReadiness(fakeApi(good({ '/v1/appStoreVersionLocalizations/loc/placements': [], '/v1/appStoreVersionLocalizations/loc/appScreenshotSets': [res('set', 'x')],
    '/v1/appScreenshotSets/set/appScreenshots': [res('s', 'appScreenshots', { assetDeliveryState: { state: 'AWAITING_UPLOAD' } })] })).api, '123', 'v');
  assert(abandoned.blockers.some(b => /tr: no screenshots/.test(b)));
  const f = fakeApi(good());
  const truncated = await releaseReadiness({ ...f.api, list: async (path: string) => ({ ...await f.api.list(path), truncated: path.includes('appStoreVersionLocalizations?') }) }, '123', 'v');
  assert.equal(truncated.ready, false); assert(truncated.blockers.some(b => /incomplete/.test(b)));
  const calls = f.calls.filter(c => c.path.includes('/placements'));
  assert.equal(calls.length, 1);
});
const withSubmission = (extra = {}) => good({ '/v1/reviewSubmissions/new-id': res('new-id', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }), ...extra });
test('submit requires a clean report, the typed version string and write access', async () => {
  const input = { account, appId: '123', versionId: 'v', versionString: '1.2.0', manualChecks: manualCheckIds };
  const ok = fakeApi(withSubmission());
  const result = await submitRelease(input, ok.api);
  assert.equal(result.status, 'submitted');
  assert.equal((ok.writes()[1]!.body as any).data.relationships.appStoreVersion.data.id, 'v');
  const unacknowledged = fakeApi(withSubmission());
  await assert.rejects(submitRelease({ ...input, manualChecks: [] }, unacknowledged.api), /Manual check app-privacy is not acknowledged/);
  assert.equal(unacknowledged.writes().length, 0);
  const wrong = fakeApi(withSubmission());
  await assert.rejects(submitRelease({ ...input, versionString: '9.9' }, wrong.api), /does not match/);
  const blocked = fakeApi(withSubmission({ '/v1/apps/123/appPriceSchedule': undefined }));
  await assert.rejects(submitRelease(input, blocked.api), /not ready[\s\S]*price schedule/);
  const locked = fakeApi(withSubmission());
  await assert.rejects(submitRelease({ ...input, account: readOnly }, locked.api), /read-only/);
  assert.equal(wrong.writes().length + blocked.writes().length + locked.writes().length, 0);
});
test('release submits only requested product versions that belong to the app', async () => {
  const products = {
    '/v1/apps/123/inAppPurchasesV2': [res('iap', 'inAppPurchases')],
    '/v2/inAppPurchases/iap/versions': [res('iap-v', 'inAppPurchaseVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
    '/v1/inAppPurchaseVersions/iap-v/localizations': [res('iap-l', 'inAppPurchaseLocalizations', { locale: 'en-US', name: 'Coins' })],
    '/v1/apps/123/subscriptionGroups': [res('group', 'subscriptionGroups')],
    '/v1/subscriptionGroups/group/versions': [res('group-v', 'subscriptionGroupVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
    '/v1/subscriptionGroupVersions/group-v/localizations': [res('group-l', 'subscriptionGroupLocalizations', { locale: 'en-US', name: 'Pro' })],
    '/v1/subscriptionGroups/group/subscriptions': [res('sub', 'subscriptions')],
    '/v1/subscriptions/sub/versions': [res('sub-v', 'subscriptionVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
    '/v1/subscriptionVersions/sub-v/localizations': [res('sub-l', 'subscriptionLocalizations', { locale: 'en-US', name: 'Monthly' })],
  };
  const input = { account, appId: '123', versionId: 'v', versionString: '1.2.0', manualChecks: manualCheckIds,
    productVersions: { iap: ['iap-v'], subscription: ['sub-v'], subscriptionGroup: ['group-v'] } };
  const f = fakeApi(withSubmission(products));
  await submitRelease(input, f.api);
  const items = f.writes().filter(w => w.path === '/v1/reviewSubmissionItems').map(w => (w.body as any).data.relationships);
  assert.deepEqual(items.map(r => Object.keys(r).find(k => k !== 'reviewSubmission')), ['appStoreVersion', 'inAppPurchaseVersion', 'subscriptionVersion', 'subscriptionGroupVersion']);
  assert.equal(items[1]!.inAppPurchaseVersion.data.type, 'inAppPurchaseVersions');
  assert.equal(items[2]!.subscriptionVersion.data.type, 'subscriptionVersions');
  const foreign = fakeApi(withSubmission(products));
  await assert.rejects(submitRelease({ ...input, productVersions: { iap: ['other'] } }, foreign.api), /does not belong/);
  assert.equal(foreign.writes().length, 0);
  const wrongState = fakeApi(withSubmission({ ...products, '/v2/inAppPurchases/iap/versions': [res('iap-v', 'inAppPurchaseVersions', { state: 'APPROVED' })] }));
  await assert.rejects(submitRelease({ ...input, productVersions: { iap: ['iap-v'] } }, wrongState.api), /cannot be submitted/);
  assert.equal(wrongState.writes().length, 0);
  const noLocale = fakeApi(withSubmission({ ...products, '/v1/inAppPurchaseVersions/iap-v/localizations': [] }));
  await assert.rejects(submitRelease({ ...input, productVersions: { iap: ['iap-v'] } }, noLocale.api), /needs at least one complete localization/);
  assert.equal(noLocale.writes().length, 0);
  const groupOnly = fakeApi(withSubmission(products));
  await assert.rejects(submitRelease({ ...input, productVersions: { subscriptionGroup: ['group-v'] } }, groupOnly.api), /at least one subscription version/);
  assert.equal(groupOnly.writes().length, 0);
});
test('review submission refuses more than Apple\'s 200 item limit before any write', async () => {
  const f = fakeApi(withSubmission());
  await assert.rejects(submitForReview({ account, appId: '123', items: Array.from({ length: 201 }, (_, i) => ({ relation: 'inAppPurchaseVersion', id: `product-${i}` })) }, f.api), /at most 200/);
  assert.equal(f.writes().length, 0);
});
const linked = (relation: string, id: string, state = 'READY_FOR_REVIEW') => res(`item-${id}`, 'reviewSubmissionItems', { state }, { [relation]: { data: { id, type: 'x' } } });
test('review reuses its own draft, refuses drafts holding other work, and detects a sent submission', async () => {
  const items = { account, appId: '123', items: [{ relation: 'appStoreVersion' as const, id: 'v' }] };
  const submissions = (state: string, rows: unknown[]) => ({ '/v1/apps/123/reviewSubmissions': (path: string) => new URL(path, 'https://x').searchParams.get('filter[state]')!.includes(state) ? [res('s1', 'reviewSubmissions', { state })] : [], '/v1/reviewSubmissions/s1/items': rows, '/v1/reviewSubmissions/s1': res('s1', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }) }) as never;
  const own = fakeApi(submissions('READY_FOR_REVIEW', [linked('appStoreVersion', 'v')]));
  assert.deepEqual((await submitForReview(items, own.api)).addedItems, []);
  assert.deepEqual(own.writes().map(w => w.method), ['PATCH']);
  const foreign = fakeApi(submissions('READY_FOR_REVIEW', [linked('appEvent', 'promo')]));
  await assert.rejects(submitForReview(items, foreign.api), /other items \(appEvent:promo\)/);
  const opaque = fakeApi(submissions('READY_FOR_REVIEW', [res('i', 'reviewSubmissionItems', { state: 'READY_FOR_REVIEW' })]));
  await assert.rejects(submitForReview(items, opaque.api), /1 unidentified/);
  assert.equal(foreign.writes().length + opaque.writes().length, 0);
  const sent = fakeApi(submissions('IN_REVIEW', [linked('appStoreVersion', 'v')]));
  assert.equal((await submitForReview(items, sent.api)).status, 'already_submitted');
  assert.equal(sent.writes().length, 0);
  const removed = fakeApi(submissions('READY_FOR_REVIEW', [linked('appEvent', 'promo', 'REMOVED')]));
  assert.deepEqual((await submitForReview(items, removed.api)).addedItems, ['v']);
});
test('rejected submission is sent again, and a lost submit response reconciles on rerun', async () => {
  const items = { account, appId: '123', items: [{ relation: 'appStoreVersion' as const, id: 'v' }] };
  const open = (state: string, rows: unknown[]) => ({ '/v1/apps/123/reviewSubmissions': (path: string) => new URL(path, 'https://x').searchParams.get('filter[state]')!.includes(state) ? [res('s1', 'reviewSubmissions', { state })] : [], '/v1/reviewSubmissions/s1/items': rows, '/v1/reviewSubmissions/s1': res('s1', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }) }) as never;
  const rejected = fakeApi(open('UNRESOLVED_ISSUES', [linked('appStoreVersion', 'v', 'REJECTED')]));
  const again = await submitForReview(items, rejected.api);
  assert.equal(again.status, 'resubmitted');
  assert.deepEqual(rejected.writes().map(w => [w.method, w.path]), [['PATCH', '/v1/reviewSubmissions/s1']]);
  const mixed = fakeApi(open('UNRESOLVED_ISSUES', [linked('appStoreVersion', 'v', 'REJECTED'), linked('appEvent', 'promo', 'REJECTED')]));
  await assert.rejects(submitForReview(items, mixed.api), /other items/);
  const version = res('v', 'appStoreVersions', { appVersionState: 'WAITING_FOR_REVIEW', versionString: '1.2.0' }, { app: { data: { id: '123', type: 'apps' } } });
  const sent = fakeApi(good({ '/v1/appStoreVersions/v': version, ...(open('WAITING_FOR_REVIEW', [linked('appStoreVersion', 'v')]) as object) }));
  assert.equal((await submitRelease({ account, appId: '123', versionId: 'v', versionString: '1.2.0' }, sent.api)).status, 'already_submitted');
  assert.equal(sent.writes().length, 0);
});
test('publish only releases PENDING_DEVELOPER_RELEASE and is repeat-safe', async () => {
  const input = { account, appId: '123', versionId: 'v', versionString: '1.2.0' };
  const version = (state: string) => good({ '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appVersionState: state, versionString: '1.2.0' }, { app: { data: { id: '123', type: 'apps' } } }) });
  const pending = fakeApi(version('PENDING_DEVELOPER_RELEASE'));
  assert.equal((await publishRelease(input, pending.api)).status, 'released');
  assert.equal(pending.writes()[0]!.path, '/v1/appStoreVersionReleaseRequests');
  const live = fakeApi(version('READY_FOR_DISTRIBUTION'));
  assert.equal((await publishRelease(input, live.api)).status, 'already_released');
  const review = fakeApi(version('IN_REVIEW'));
  await assert.rejects(publishRelease(input, review.api), /Only PENDING_DEVELOPER_RELEASE/);
  await assert.rejects(publishRelease({ ...input, versionString: '1.1' }, pending.api), /does not match/);
  assert.equal(live.writes().length + review.writes().length, 0);
});
