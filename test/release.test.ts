import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseReadiness, submitRelease, publishRelease } from '../src/release.js';
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
test('a complete version is ready and still lists what could not be checked', async () => {
  const report = await releaseReadiness(fakeApi(good()).api, '123', 'v');
  assert.deepEqual(report.blockers, []); assert.equal(report.ready, true);
  assert(report.notChecked.some(n => /Privacy/.test(n)));
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
  assert.deepEqual(first.blockers, []);
  await assert.rejects(releaseReadiness(fakeApi(good({ '/v1/appStoreVersions/v': res('v', 'appStoreVersions', {}, { app: { data: { id: '999', type: 'apps' } } }) })).api, '123', 'v'), /does not belong/);
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
  const ok = fakeApi(withSubmission());
  const result = await submitRelease({ account, appId: '123', versionId: 'v', versionString: '1.2.0' }, ok.api);
  assert.equal(result.status, 'submitted');
  assert.equal((ok.writes()[1]!.body as any).data.relationships.appStoreVersion.data.id, 'v');
  const wrong = fakeApi(withSubmission());
  await assert.rejects(submitRelease({ account, appId: '123', versionId: 'v', versionString: '9.9' }, wrong.api), /does not match/);
  const blocked = fakeApi(withSubmission({ '/v1/apps/123/appPriceSchedule': undefined }));
  await assert.rejects(submitRelease({ account, appId: '123', versionId: 'v', versionString: '1.2.0' }, blocked.api), /not ready[\s\S]*price schedule/);
  const locked = fakeApi(withSubmission());
  await assert.rejects(submitRelease({ account: readOnly, appId: '123', versionId: 'v', versionString: '1.2.0' }, locked.api), /read-only/);
  assert.equal(wrong.writes().length + blocked.writes().length + locked.writes().length, 0);
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
