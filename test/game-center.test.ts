import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gc from '../src/game-center.js';
import { AppleError } from '../src/apple.js';
import { account, readOnly, res, fakeApi, png } from './helpers.js';

const owned = { app: { data: { id: '123', type: 'apps' } } };
const game = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/apps/123/gameCenterDetail': res('gcd', 'gameCenterDetails'),
  '/v1/gameCenterDetails/gcd/gameCenterLeaderboards': [res('lb', 'gameCenterLeaderboards', { vendorIdentifier: 'high_score', scoreSortType: 'DESC' })],
  '/v1/gameCenterDetails/gcd/gameCenterAchievements': [res('ach', 'gameCenterAchievements', { vendorIdentifier: 'first_win', points: 100 }), res('old', 'x', { points: 900, archived: true }), res('a2', 'x', { points: 850 })],
  '/v1/gameCenterLeaderboards/lb/localizations': [res('lbl', 'gameCenterLeaderboardLocalizations', { locale: 'en-US', name: 'High Score' })],
  '/v1/gameCenterAchievements/ach/localizations': [res('acl', 'gameCenterAchievementLocalizations', { locale: 'en-US', name: 'First' })],
  '/v1/gameCenterDetails/gcd/leaderboardReleases': [],
  '/v1/gameCenterDetails/gcd/achievementReleases': [res('rel', 'gameCenterAchievementReleases', { live: true })],
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION' }, owned),
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split('/').at(-1)}`, body.data.type) });
const base = { account, appId: '123' };

test('enabling Game Center is idempotent for the app and a version', async () => {
  const fresh = game({ '/v1/apps/123/gameCenterDetail': undefined });
  const result = await gc.enableGameCenter({ ...base, versionId: 'v' }, fresh.api);
  assert.equal(result.status, 'enabled'); assert.equal(result.version?.status, 'enabled');
  assert.deepEqual(fresh.writes().map(w => w.path), ['/v1/gameCenterDetails', '/v1/gameCenterAppVersions']);
  const done = game({ '/v1/appStoreVersions/v/gameCenterAppVersion': res('gav', 'gameCenterAppVersions') });
  assert.deepEqual(await gc.enableGameCenter({ ...base, versionId: 'v' }, done.api), { status: 'exists', gameCenterId: 'gcd', version: { status: 'exists', id: 'gav' } });
  assert.equal(done.writes().length, 0);
  await assert.rejects(gc.createLeaderboard({ ...base, vendorIdentifier: 'x', referenceName: 'X', formatter: 'INTEGER', scoreSortType: 'DESC', submissionType: 'BEST_SCORE' }, game({ '/v1/apps/123/gameCenterDetail': undefined }).api), /gc-enable first/);
  await assert.rejects(gc.enableGameCenter({ ...base, account: readOnly }, fresh.api), /read-only/);
});
test('leaderboards are created once by vendor ID, validated, updated and localized', async () => {
  const f = game();
  const lb = { ...base, vendorIdentifier: 'weekly', referenceName: 'Weekly', formatter: 'ELAPSED_TIME_SECOND', scoreSortType: 'ASC', submissionType: 'BEST_SCORE', scoreRangeStart: '0', scoreRangeEnd: '3600' };
  assert.equal((await gc.createLeaderboard(lb, f.api)).status, 'created');
  assert.equal((f.writes()[0]!.body as any).data.attributes.defaultFormatter, 'ELAPSED_TIME_SECOND');
  assert.equal((await gc.createLeaderboard({ ...lb, vendorIdentifier: 'high_score' }, f.api)).status, 'exists');
  await assert.rejects(gc.createLeaderboard({ ...lb, formatter: 'STARS' }, f.api), /Formatter/);
  await assert.rejects(gc.createLeaderboard({ ...lb, scoreRangeStart: '10', scoreRangeEnd: '5' }, f.api), /below its end/);
  await assert.rejects(gc.createLeaderboard({ ...lb, vendorIdentifier: 'has space' }, f.api), /Vendor identifier/);
  assert.equal((await gc.updateLeaderboard({ ...base, leaderboardId: 'lb', scoreSortType: 'DESC' }, f.api)).status, 'unchanged');
  assert.deepEqual((await gc.updateLeaderboard({ ...base, leaderboardId: 'lb', archived: true }, f.api) as { changed?: string[] }).changed, ['archived']);
  assert.equal((await gc.localizeLeaderboard({ ...base, leaderboardId: 'lb', locale: 'tr', name: 'En Yüksek', formatterSuffix: 'puan' }, f.api)).status, 'created');
  await assert.rejects(gc.localizeLeaderboard({ ...base, leaderboardId: 'lb', locale: 'de', description: 'x' }, f.api), /--name is required/);
  await assert.rejects(gc.updateLeaderboard({ ...base, leaderboardId: 'foreign', archived: true }, f.api), /does not belong/);
});
test('achievements respect the 100 and 1000 point limits and need full text for a new language', async () => {
  const f = game();
  const ach = { ...base, vendorIdentifier: 'boss', referenceName: 'Boss', points: 50, showBeforeEarned: true, repeatable: false };
  assert.equal((await gc.createAchievement(ach, f.api)).status, 'created');
  await assert.rejects(gc.createAchievement({ ...ach, points: 51 }, f.api), /1001 points.*50 left/);
  await assert.rejects(gc.createAchievement({ ...ach, points: 101 }, f.api), /1 to 100/);
  assert.equal((await gc.createAchievement({ ...ach, vendorIdentifier: 'first_win', points: 999 }, f.api)).status, 'exists');
  await assert.rejects(gc.updateAchievement({ ...base, achievementId: 'ach', points: 100 + 51 }, f.api), /1 to 100/);
  assert.equal((await gc.updateAchievement({ ...base, achievementId: 'ach', points: 100 }, f.api)).status, 'unchanged');
  assert.equal((await gc.localizeAchievement({ ...base, achievementId: 'ach', locale: 'tr', name: 'İlk', beforeEarnedDescription: 'Kazan', afterEarnedDescription: 'Kazandın' }, f.api)).status, 'created');
  await assert.rejects(gc.localizeAchievement({ ...base, achievementId: 'ach', locale: 'de', name: 'Erste' }, f.api), /--before and --after/);
  assert.equal((await gc.localizeAchievement({ ...base, achievementId: 'ach', locale: 'en-US', name: 'First win' }, f.api)).status, 'updated');
  await assert.rejects(gc.localizeAchievement({ ...base, achievementId: 'ach', locale: 'tr', name: 'x'.repeat(31), beforeEarnedDescription: 'a', afterEarnedDescription: 'b' }, f.api), /30/);
});
test('images upload per language and replace the previous image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-')); const filePath = join(dir, 'i.png'); const bytes = png(512, 512); writeFileSync(filePath, bytes);
  const ops = [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: bytes.length, requestHeaders: [] }];
  const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
  const f = game({ '/v1/gameCenterLeaderboardLocalizations/lbl/gameCenterLeaderboardImage': res('old-img', 'gameCenterLeaderboardImages') }, );
  const api = { ...f.api, post: async (path: string, body: any) => { const r = await f.api.post(path, body); return { ...r, attributes: { uploadOperations: ops } }; } };
  try {
    const result = await gc.uploadGameCenterImage({ ...base, kind: 'leaderboard', itemId: 'lb', locale: 'en-US', filePath }, api, fetcher);
    assert.equal(result.replaced, 'old-img');
    assert.deepEqual(f.writes().map(w => w.method), ['POST', 'PATCH', 'DELETE']);
    await assert.rejects(gc.uploadGameCenterImage({ ...base, kind: 'achievement', itemId: 'ach', locale: 'tr', filePath }, api, fetcher), /Add the tr language first/);
    let posts = 0;
    const refusing = game({ '/v1/gameCenterAchievementLocalizations/acl/gameCenterAchievementImage': res('old', 'x') });
    const api2 = { ...refusing.api, post: async (path: string, body: any) => { if (++posts === 1) throw new AppleError(409, []); const r = await refusing.api.post(path, body); return { ...r, attributes: { uploadOperations: ops } }; } };
    await gc.uploadGameCenterImage({ ...base, kind: 'achievement', itemId: 'ach', locale: 'en-US', filePath }, api2, fetcher);
    assert.deepEqual(refusing.writes().map(w => w.method), ['DELETE', 'POST', 'PATCH']);
  } finally { rmSync(dir, { recursive: true }); }
});
test('releasing makes an item live once', async () => {
  const f = game();
  assert.equal((await gc.releaseGameCenterItem({ ...base, kind: 'leaderboard', itemId: 'lb' }, f.api)).status, 'released');
  const body = f.writes()[0]!.body as any;
  assert.equal(body.data.relationships.gameCenterLeaderboard.data.id, 'lb');
  assert.equal(body.data.relationships.gameCenterDetail.data.id, 'gcd');
  assert.equal((await gc.releaseGameCenterItem({ ...base, kind: 'achievement', itemId: 'ach' }, f.api)).status, 'already_released');
  assert.equal(f.writes().length, 1);
});
