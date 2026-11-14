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
  '/v1/gameCenterDetails/gcd/gameCenterLeaderboardSets': [res('set', 'gameCenterLeaderboardSets', { vendorIdentifier: 'season' })],
  '/v1/gameCenterDetails/gcd/gameCenterActivities': [res('act', 'gameCenterActivities', { vendorIdentifier: 'dungeon' })],
  '/v1/gameCenterDetails/gcd/gameCenterChallenges': [res('ch', 'gameCenterChallenges', { vendorIdentifier: 'weekly race' })],
  '/v2/gameCenterLeaderboards/lb/versions': [res('lbv-live', 'gameCenterLeaderboardVersions', { state: 'LIVE' }), res('lbv', 'gameCenterLeaderboardVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
  '/v2/gameCenterLeaderboardVersions/lbv/localizations': [res('lbl', 'gameCenterLeaderboardLocalizations', { locale: 'en-US', name: 'High Score' })],
  '/v2/gameCenterAchievements/ach/versions': [res('achv', 'gameCenterAchievementVersions', { state: 'LIVE' })],
  '/v1/gameCenterActivities/act/versions': [res('actv', 'gameCenterActivityVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
  '/v1/gameCenterActivityVersions/actv/localizations': [res('actl', 'gameCenterActivityLocalizations', { locale: 'en-US', name: 'Dungeon' })],
  '/v1/gameCenterDetails/gcd/activityReleases': [],
  '/v2/gameCenterLeaderboardSets/set/gameCenterLeaderboards': [],
  '/v1/appStoreVersions/v': res('v', 'appStoreVersions', { appStoreState: 'PREPARE_FOR_SUBMISSION' }, owned),
  '/v1/apps/123/reviewSubmissions': [],
  '/v1/reviewSubmissions/new-reviewSubmissions': res('new-reviewSubmissions', 'reviewSubmissions', { state: 'WAITING_FOR_REVIEW' }),
  '/v1/gameCenterGroups': [res('grp', 'gameCenterGroups', { referenceName: 'Shared' })],
  '/v1/gameCenterGroups/grp': res('grp', 'gameCenterGroups', { referenceName: 'Shared' }),
  '/v1/gameCenterMatchmakingRuleSets': [res('rs', 'gameCenterMatchmakingRuleSets', { referenceName: 'ranked' })],
  '/v1/gameCenterMatchmakingRuleSets/rs/rules': [],
  '/v1/gameCenterMatchmakingRuleSets/rs/teams': [],
  '/v1/gameCenterMatchmakingQueues': [],
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split('/').at(-1)}`, body.data.type) });
const base = { account, appId: '123' };
const lb = { ...base, kind: 'leaderboard' as const, vendorIdentifier: 'weekly', referenceName: 'Weekly', formatter: 'ELAPSED_TIME_SECOND', scoreSortType: 'ASC', submissionType: 'BEST_SCORE' };

test('enabling Game Center is idempotent for the app and a version', async () => {
  const fresh = game({ '/v1/apps/123/gameCenterDetail': undefined });
  const result = await gc.enableGameCenter({ ...base, versionId: 'v' }, fresh.api);
  assert.equal(result.status, 'enabled'); assert.equal(result.version?.status, 'enabled');
  const done = game({ '/v1/appStoreVersions/v/gameCenterAppVersion': res('gav', 'gameCenterAppVersions') });
  assert.deepEqual(await gc.enableGameCenter({ ...base, versionId: 'v' }, done.api), { status: 'exists', gameCenterId: 'gcd', version: { status: 'exists', id: 'gav' } });
  await assert.rejects(gc.createItem(lb, game({ '/v1/apps/123/gameCenterDetail': undefined }).api), /gc-enable first/);
  await assert.rejects(gc.enableGameCenter({ ...base, account: readOnly }, fresh.api), /read-only/);
});
test('items are created with their first version through the v2 endpoints', async () => {
  const f = game();
  assert.equal((await gc.createItem({ ...lb, scoreRangeStart: '0', scoreRangeEnd: '3600', recurrenceStartDate: '2027-01-05T00:00:00Z', recurrenceDuration: 'P7D', recurrenceRule: 'FREQ=WEEKLY;INTERVAL=1' }, f.api)).status, 'created');
  const body = f.writes()[0]!;
  assert.equal(body.path, '/v2/gameCenterLeaderboards');
  assert.deepEqual((body.body as any).included, [{ type: 'gameCenterLeaderboardVersions', id: '${version}' }]);
  assert.equal((body.body as any).data.attributes.defaultFormatter, 'ELAPSED_TIME_SECOND');
  assert.equal((await gc.createItem({ ...lb, vendorIdentifier: 'high_score' }, f.api)).status, 'exists');
  await gc.createItem({ ...base, kind: 'leaderboard-set', vendorIdentifier: 'season2', referenceName: 'Season 2' }, f.api);
  await gc.createItem({ ...base, kind: 'activity', vendorIdentifier: 'raid', referenceName: 'Raid', playStyle: 'SYNCHRONOUS', minimumPlayersCount: 2, maximumPlayersCount: 4, supportsPartyCode: true, properties: { level: '5' } }, f.api);
  await gc.createItem({ ...base, kind: 'challenge', vendorIdentifier: 'sprint 1', referenceName: 'Sprint', leaderboardId: 'lb', repeatable: true }, f.api);
  const challenge = f.writes().at(-1)!.body as any;
  assert.equal(challenge.data.attributes.challengeType, 'LEADERBOARD');
  assert.equal(challenge.data.relationships.leaderboardV2.data.id, 'lb');
});
test('item rules follow what Apple documents', async () => {
  const f = game();
  await assert.rejects(gc.createItem({ ...lb, formatter: undefined }, f.api), /needs formatter/);
  await assert.rejects(gc.createItem({ ...lb, scoreRangeStart: '5' }, f.api), /both --range-start and --range-end/);
  await assert.rejects(gc.createItem({ ...lb, scoreRangeStart: '5', scoreRangeEnd: '5' }, f.api), /must differ/);
  await assert.rejects(gc.createItem({ ...lb, scoreRangeStart: '0.5', scoreRangeEnd: '9' }, f.api), /64-bit whole numbers/);
  await assert.rejects(gc.createItem({ ...lb, scoreRangeStart: '0', scoreRangeEnd: '9223372036854775808' }, f.api), /64-bit/);
  await assert.rejects(gc.createItem({ ...lb, recurrenceDuration: 'P7D' }, f.api), /together/);
  await assert.rejects(gc.createItem({ ...lb, recurrenceStartDate: '2027-01-05T00:00:00Z', recurrenceDuration: '7 days', recurrenceRule: 'FREQ=WEEKLY' }, f.api), /ISO 8601 duration/);
  await assert.rejects(gc.createItem({ ...lb, vendorIdentifier: 'x'.repeat(101) }, f.api), /1-100/);
  await assert.rejects(gc.createItem({ ...lb, vendorIdentifier: 'has space' }, f.api), /1-100/);
  await assert.rejects(gc.createItem({ ...lb, points: 5 }, f.api), /points do not apply to leaderboard/);
  await assert.rejects(gc.createItem({ ...base, kind: 'challenge', vendorIdentifier: 'c', referenceName: 'C' }, f.api), /built on a leaderboard/);
  await assert.rejects(gc.createItem({ ...base, kind: 'challenge', vendorIdentifier: 'c', referenceName: 'C', leaderboardId: 'foreign' }, f.api), /Leaderboard does not belong/);
  const ach = { ...base, kind: 'achievement' as const, vendorIdentifier: 'boss', referenceName: 'Boss', showBeforeEarned: true, repeatable: false };
  assert.equal((await gc.createItem({ ...ach, points: 50 }, f.api)).status, 'created');
  await assert.rejects(gc.createItem({ ...ach, points: 51 }, f.api), /1001 points.*50 left/);
  await assert.rejects(gc.createItem({ ...ach, points: 101 }, f.api), /1 to 100/);
  await assert.rejects(gc.createItem({ ...base, kind: 'activity', vendorIdentifier: 'a', referenceName: 'A', minimumPlayersCount: 4, maximumPlayersCount: 2 }, f.api), /cannot exceed/);
});
test('updates change only differing fields and respect the point budget', async () => {
  const f = game();
  assert.equal((await gc.updateItem({ ...base, kind: 'leaderboard', id: 'lb', scoreSortType: 'DESC' }, f.api)).status, 'unchanged');
  assert.deepEqual((await gc.updateItem({ ...base, kind: 'leaderboard', id: 'lb', archived: true }, f.api) as { changed?: string[] }).changed, ['archived']);
  assert.equal(f.writes()[0]!.path, '/v2/gameCenterLeaderboards/lb');
  const full = game({ '/v1/gameCenterDetails/gcd/gameCenterAchievements': [res('ach', 'gameCenterAchievements', { points: 10 }), res('a2', 'x', { points: 950 })] });
  await assert.rejects(gc.updateItem({ ...base, kind: 'achievement', id: 'ach', points: 60 }, full.api), /1010 points.*50 left/);
  assert.equal((await gc.updateItem({ ...base, kind: 'achievement', id: 'ach', points: 50 }, full.api)).status, 'updated');
  await assert.rejects(gc.updateItem({ ...base, kind: 'achievement', id: 'old', archived: false }, f.api), /at most 1000/);
  await assert.rejects(gc.updateItem({ ...base, kind: 'leaderboard', id: 'foreign', archived: true }, f.api), /does not belong/);
  await assert.rejects(gc.updateItem({ ...base, kind: 'leaderboard', id: 'lb' }, f.api), /field to change/);
});
test('languages go on the editable version; a fully live item needs a new version first', async () => {
  const f = game();
  const created = await gc.localizeItem({ ...base, kind: 'leaderboard', id: 'lb', locale: 'tr', text: { name: 'En Yüksek', formatterSuffix: 'puan' } }, f.api);
  assert.equal(created.versionId, 'lbv');
  assert.equal((f.writes()[0]!.body as any).data.relationships.version.data.id, 'lbv');
  assert.equal((await gc.localizeItem({ ...base, kind: 'leaderboard', id: 'lb', locale: 'en-US', text: { name: 'High Score' } }, f.api)).status, 'unchanged');
  await assert.rejects(gc.localizeItem({ ...base, kind: 'achievement', id: 'ach', locale: 'tr', text: { name: 'X', beforeEarnedDescription: 'a', afterEarnedDescription: 'b' } }, f.api), /gc-version-create/);
  assert.deepEqual(await gc.createItemVersion({ ...base, kind: 'achievement', id: 'ach' }, f.api), { status: 'created', versionId: 'new-gameCenterAchievementVersions' });
  assert.equal((f.writes().at(-1)!.body as any).data.relationships.achievement.data.id, 'ach');
  assert.equal((await gc.createItemVersion({ ...base, kind: 'leaderboard', id: 'lb' }, f.api)).status, 'exists');
  await assert.rejects(gc.localizeItem({ ...base, kind: 'leaderboard', id: 'lb', locale: 'de', text: { description: 'x' } }, f.api), /needs name/);
  await assert.rejects(gc.localizeItem({ ...base, kind: 'leaderboard', id: 'lb', locale: 'de', text: { name: 'x', beforeEarnedDescription: 'y' } }, f.api), /do not apply to leaderboard/);
});
test('images are checked against Apple pixel sizes and replace the previous one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-'));
  const square = join(dir, 's.png'); writeFileSync(square, png(1024, 1024));
  const wide = join(dir, 'w.png'); writeFileSync(wide, png(3840, 2160));
  const alpha = join(dir, 'a.png'); writeFileSync(alpha, png(3840, 2160, 6));
  const ops = (size: number) => [{ method: 'PUT', url: 'https://x.apple.com/1', offset: 0, length: size, requestHeaders: [] }];
  const fetcher = (async (_u: string, init: RequestInit) => { for await (const _ of init.body as unknown as AsyncIterable<Buffer>); return new Response(null); }) as typeof fetch;
  const f = game({ '/v2/gameCenterLeaderboardLocalizations/lbl/image': res('old-img', 'gameCenterLeaderboardImages') });
  const api = { ...f.api, post: async (path: string, body: any) => { const r = await f.api.post(path, body); return { ...r, attributes: { uploadOperations: ops(body.data.attributes.fileSize) } }; } };
  try {
    const result = await gc.uploadItemImage({ ...base, kind: 'leaderboard', id: 'lb', locale: 'en-US', filePath: square }, api, fetcher);
    assert.equal(result.replaced, 'old-img');
    assert.deepEqual(f.writes().map(w => [w.method, w.path]), [['POST', '/v2/gameCenterLeaderboardImages'], ['PATCH', '/v2/gameCenterLeaderboardImages/new-gameCenterLeaderboardImages'], ['DELETE', '/v2/gameCenterLeaderboardImages/old-img']]);
    await assert.rejects(gc.uploadItemImage({ ...base, kind: 'leaderboard', id: 'lb', locale: 'en-US', filePath: wide }, api, fetcher), /1024x1024 pixels; this one is 3840x2160/);
    await assert.rejects(gc.uploadItemImage({ ...base, kind: 'leaderboard', id: 'lb', filePath: square }, api, fetcher), /pass --locale/);
    await gc.uploadItemImage({ ...base, kind: 'activity', id: 'act', filePath: wide }, api, fetcher);
    assert.equal((f.writes().at(-2)!.body as any).data.relationships.version.data.id, 'actv');
    await assert.rejects(gc.uploadItemImage({ ...base, kind: 'activity', id: 'act', filePath: alpha }, api, fetcher), /transparency/);
    await assert.rejects(gc.uploadItemImage({ ...base, kind: 'activity', id: 'act', locale: 'tr', filePath: wide }, api, fetcher), /Add the tr language first/);
    let posts = 0;
    const refusing = game({ '/v2/gameCenterLeaderboardLocalizations/lbl/image': res('old', 'x') });
    const api2 = { ...refusing.api, post: async (path: string, body: any) => { if (++posts === 1) throw new AppleError(409, []); const r = await refusing.api.post(path, body); return { ...r, attributes: { uploadOperations: ops(body.data.attributes.fileSize) } }; } };
    await gc.uploadItemImage({ ...base, kind: 'leaderboard', id: 'lb', locale: 'en-US', filePath: square }, api2, fetcher);
    assert.deepEqual(refusing.writes().map(w => w.method), ['DELETE', 'POST', 'PATCH']);
  } finally { rmSync(dir, { recursive: true }); }
});
test('submitting sends the version to App Review; activities and challenges get a version release first', async () => {
  const f = game();
  const lbResult = await gc.submitItem({ ...base, kind: 'leaderboard', id: 'lb', appVersionId: 'v' }, f.api);
  assert.equal(lbResult.versionId, 'lbv');
  const items = f.writes().filter(w => w.path === '/v1/reviewSubmissionItems').map(w => Object.keys((w.body as any).data.relationships).find(k => k !== 'reviewSubmission'));
  assert.deepEqual(items, ['gameCenterLeaderboardVersion', 'appStoreVersion']);
  assert.equal(f.writes().some(w => /Releases$/.test(w.path)), false);
  const act = game();
  await gc.submitItem({ ...base, kind: 'activity', id: 'act' }, act.api);
  assert.equal(act.writes()[0]!.path, '/v1/gameCenterActivityVersionReleases');
  assert.equal((act.writes()[0]!.body as any).data.relationships.version.data.id, 'actv');
  const empty = game({ '/v2/gameCenterLeaderboardVersions/lbv/localizations': [] });
  await assert.rejects(gc.submitItem({ ...base, kind: 'leaderboard', id: 'lb' }, empty.api), /at least one language/);
});
test('sets, activity links, default leaderboard, groups and matchmaking', async () => {
  const f = game();
  assert.equal((await gc.setLeaderboardSetMembers({ ...base, setId: 'set', leaderboardIds: ['lb', 'lb'] }, f.api)).status, 'updated');
  assert.deepEqual(f.writes()[0]!.body, { data: [{ type: 'gameCenterLeaderboards', id: 'lb' }] });
  await assert.rejects(gc.setLeaderboardSetMembers({ ...base, setId: 'set', leaderboardIds: ['zz'] }, f.api), /not in this app: zz/);
  await gc.linkToActivity({ ...base, kind: 'achievement', id: 'ach', activityId: 'act' }, f.api);
  assert.equal(f.writes().at(-1)!.path, '/v2/gameCenterAchievements/ach/relationships/activity');
  await assert.rejects(gc.linkToActivity({ ...base, kind: 'leaderboard', id: 'lb', activityId: 'nope' }, f.api), /Activity does not belong/);
  await gc.setDefaultLeaderboard({ ...base, leaderboardId: 'lb' }, f.api);
  assert.equal((f.writes().at(-1)!.body as any).data.relationships.defaultLeaderboardV2.data.id, 'lb');
  assert.equal((await gc.createGroup({ account, referenceName: 'Shared' }, f.api)).status, 'exists');
  assert.equal((await gc.joinGroup({ ...base, groupId: 'grp' }, f.api)).dryRun, true);
  const before = f.writes().length;
  assert.equal((await gc.joinGroup({ ...base, groupId: 'grp', execute: true }, f.api) as { status?: string }).status, 'joined');
  assert.equal(f.writes().length, before + 1);
  assert.equal((await gc.createRuleSet({ account, referenceName: 'ranked', minPlayers: 2, maxPlayers: 4 }, f.api)).status, 'exists');
  assert.equal((await gc.createRuleSet({ account, referenceName: 'casual', minPlayers: 2, maxPlayers: 8 }, f.api)).status, 'created');
  assert.equal((await gc.createRule({ account, ruleSetId: 'rs', referenceName: 'skill', type: 'MATCH', expression: 'requests[0].properties.skill == requests[1].properties.skill', description: 'Same skill' }, f.api)).status, 'created');
  assert.equal((await gc.createTeam({ account, ruleSetId: 'rs', referenceName: 'red', minPlayers: 1, maxPlayers: 2 }, f.api)).status, 'created');
  assert.equal((await gc.createQueue({ account, ruleSetId: 'rs', referenceName: 'main', classicBundleIds: ['com.example.game'] }, f.api)).status, 'created');
  await assert.rejects(gc.createRule({ account, ruleSetId: 'other', referenceName: 'r', type: 'MATCH', expression: 'x', description: 'y' }, f.api), /Rule set not found/);
  await assert.rejects(gc.createRule({ account, ruleSetId: 'rs', referenceName: 'r', type: 'FUZZY', expression: 'x', description: 'y' }, f.api), /Rule type/);
  await assert.rejects(gc.createRuleSet({ account: readOnly, referenceName: 'x', minPlayers: 2, maxPlayers: 2 }, f.api), /read-only/);
});
