import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseReadiness, submitRelease, publishRelease } from '../src/release.js';
import { submitForReview } from '../src/review.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const good = (over: Record<string, unknown> = {}) => ({
  '/v1/appStoreVersions/v/app': res('123', 'apps'),
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION', versionString: '1.2.0', copyright: '2026 X', platform: 'IOS' }),
  '/v1/appStoreVersions/v/build': res('b', 'builds', { processingState: 'VALID', expired: false, usesNonExemptEncryption: false }),
  '/v1/apps/123/appStoreVersions': [res('v', 'appStoreVersions'), res('old', 'appStoreVersions', { appStoreState: 'READY_FOR_SALE' })],
  '/v1/appStoreVersions/v/appStoreVersionLocalizations': [res('loc', 'appStoreVersionLocalizations', { locale: 'tr', description: 'd', keywords: 'k', supportUrl: 'https://x', whatsNew: 'n' })],
  '/v1/appStoreVersionLocalizations/loc/placements': (path: string) => path.includes('APP_SCREENSHOT') ? [res('s', 'appAssetLibraryPlacements')] : [],
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
    '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION', versionString: '1.2.0' }),
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
    '/v1/appStoreVersionLocalizations/loc/appScreenshotSets': [res('set', 'appScreenshotSets')], '/v1/appScreenshotSets/set/appScreenshots': [res('s', 'appScreenshots')] })).api, '123', 'v');
  assert.deepEqual(first.blockers, []);
  await assert.rejects(releaseReadiness(fakeApi(good({ '/v1/appStoreVersions/v/app': res('999', 'apps') })).api, '123', 'v'), /does not belong/);
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
test('publish only releases PENDING_DEVELOPER_RELEASE and is repeat-safe', async () => {
  const input = { account, appId: '123', versionId: 'v', versionString: '1.2.0' };
  const version = (state: string) => good({ '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appVersionState: state, versionString: '1.2.0' }) });
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
