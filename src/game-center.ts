import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import { EDITABLE_VERSION_STATES, validId, versionOfApp } from './apple-rules.js';
import { readImage } from './screenshots.js';
import { putFilePart, validateOperations } from './upload-transfer.js';

export interface GameCenterAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  delete(path: string): Promise<void>;
}
const rel = (type: string, id: string) => ({ data: { type, id } });
const clean = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const chars = (value: string | undefined, max: number, label: string) => { if (value !== undefined && [...value].length > max) throw new Error(`${label} is limited to ${max} characters.`); };
const checkLocale = (value: string) => { if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) throw new Error(`Invalid locale ${value}.`); };
async function optional(api: Pick<GameCenterAPI, 'get'>, path: string): Promise<Resource | undefined> {
  try { return (await api.get(path)) ?? undefined; }
  catch (error) { if (error instanceof AppleError && error.status === 404) return undefined; throw error; }
}
async function all(api: Pick<GameCenterAPI, 'list'>, path: string): Promise<Resource[]> {
  const rows = await api.list(path, 2000);
  if (rows.truncated) throw new Error(`Incomplete list at ${path.split('?')[0]}; refusing to continue.`);
  return rows.data;
}
async function detail(api: GameCenterAPI, appId: string): Promise<Resource> {
  if (!/^\d+$/.test(appId)) throw new Error('Invalid app ID.');
  const found = await optional(api, `/v1/apps/${appId}/gameCenterDetail`);
  if (!found) throw new Error('Game Center is not enabled for this app. Run gc-enable first.');
  return found;
}

/** Enables Game Center for the app and, optionally, for one App Store version. Safe to rerun. */
export async function enableGameCenter(input: { account: Account; appId: string; versionId?: string }, api: GameCenterAPI) {
  const { account, appId, versionId } = input;
  requireWrite(account, appId);
  if (!/^\d+$/.test(appId)) throw new Error('Invalid app ID.');
  const existing = await optional(api, `/v1/apps/${appId}/gameCenterDetail`);
  const gameCenter = existing ?? await api.post('/v1/gameCenterDetails', { data: { type: 'gameCenterDetails', relationships: { app: rel('apps', appId) } } });
  let version: { status: 'exists' | 'enabled'; id: string } | undefined;
  if (versionId) {
    if (!validId(versionId)) throw new Error('Invalid version ID.');
    const appVersion = await versionOfApp(api, appId, versionId);
    if (!EDITABLE_VERSION_STATES.includes(String(appVersion.attributes.appStoreState))) throw new Error(`Version is not editable: ${appVersion.attributes.appStoreState}`);
    const current = await optional(api, `/v1/appStoreVersions/${versionId}/gameCenterAppVersion`);
    version = current ? { status: 'exists', id: current.id }
      : { status: 'enabled', id: (await api.post('/v1/gameCenterAppVersions', { data: { type: 'gameCenterAppVersions', relationships: { appStoreVersion: rel('appStoreVersions', versionId) } } })).id };
  }
  return { status: existing ? 'exists' as const : 'enabled' as const, gameCenterId: gameCenter.id, ...(version ? { version } : {}) };
}

// ---- Leaderboards ----
export const FORMATTERS = ['INTEGER', 'DECIMAL_POINT_1_PLACE', 'DECIMAL_POINT_2_PLACE', 'DECIMAL_POINT_3_PLACE', 'ELAPSED_TIME_CENTISECOND', 'ELAPSED_TIME_MINUTE', 'ELAPSED_TIME_SECOND',
  'MONEY_POUND_DECIMAL', 'MONEY_POUND', 'MONEY_DOLLAR_DECIMAL', 'MONEY_DOLLAR', 'MONEY_EURO_DECIMAL', 'MONEY_EURO', 'MONEY_FRANC_DECIMAL', 'MONEY_FRANC', 'MONEY_KRONER_DECIMAL', 'MONEY_KRONER', 'MONEY_YEN'];
const vendorId = (value: string) => { if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error('Vendor identifier may use letters, digits, dot, dash and underscore (1-100). It cannot change later.'); };
export interface LeaderboardFields { referenceName?: string; formatter?: string; scoreSortType?: string; submissionType?: string; scoreRangeStart?: string; scoreRangeEnd?: string; visibility?: string; archived?: boolean }
function leaderboardAttributes(fields: LeaderboardFields): Record<string, unknown> {
  chars(fields.referenceName, 64, 'Reference name');
  if (fields.formatter !== undefined && !FORMATTERS.includes(fields.formatter)) throw new Error(`Formatter must be one of ${FORMATTERS.join(', ')}.`);
  if (fields.scoreSortType !== undefined && !['ASC', 'DESC'].includes(fields.scoreSortType)) throw new Error('Sort must be ASC or DESC.');
  if (fields.submissionType !== undefined && !['BEST_SCORE', 'MOST_RECENT_SCORE'].includes(fields.submissionType)) throw new Error('Submission must be BEST_SCORE or MOST_RECENT_SCORE.');
  if (fields.visibility !== undefined && !['SHOW_FOR_ALL', 'HIDE_FOR_ALL'].includes(fields.visibility)) throw new Error('Visibility must be SHOW_FOR_ALL or HIDE_FOR_ALL.');
  for (const value of [fields.scoreRangeStart, fields.scoreRangeEnd]) if (value !== undefined && !/^-?\d+(\.\d+)?$/.test(value)) throw new Error('Score range values must be numbers.');
  if (fields.scoreRangeStart !== undefined && fields.scoreRangeEnd !== undefined && Number(fields.scoreRangeStart) >= Number(fields.scoreRangeEnd)) throw new Error('Score range start must be below its end.');
  return clean({ referenceName: fields.referenceName, defaultFormatter: fields.formatter, scoreSortType: fields.scoreSortType, submissionType: fields.submissionType,
    scoreRangeStart: fields.scoreRangeStart, scoreRangeEnd: fields.scoreRangeEnd, visibility: fields.visibility, archived: fields.archived });
}
const leaderboards = async (api: GameCenterAPI, gameCenterId: string) => all(api, `/v1/gameCenterDetails/${gameCenterId}/gameCenterLeaderboards?limit=200`);
async function ownedLeaderboard(api: GameCenterAPI, appId: string, leaderboardId: string): Promise<{ gameCenterId: string; leaderboard: Resource }> {
  if (!validId(leaderboardId)) throw new Error('Invalid leaderboard ID.');
  const gameCenter = await detail(api, appId);
  const leaderboard = (await leaderboards(api, gameCenter.id)).find(row => row.id === leaderboardId);
  if (!leaderboard) throw new Error('Leaderboard does not belong to this app.');
  return { gameCenterId: gameCenter.id, leaderboard };
}
/** Creates a leaderboard, or returns the one with the same vendor identifier. */
export async function createLeaderboard(input: { account: Account; appId: string; vendorIdentifier: string; referenceName: string; formatter: string; scoreSortType: string; submissionType: string } & LeaderboardFields, api: GameCenterAPI) {
  const { account, appId, vendorIdentifier, ...fields } = input;
  requireWrite(account, appId); vendorId(vendorIdentifier);
  const attributes = leaderboardAttributes(fields);
  const gameCenter = await detail(api, appId);
  const found = (await leaderboards(api, gameCenter.id)).find(row => row.attributes.vendorIdentifier === vendorIdentifier);
  if (found) return { status: 'exists' as const, leaderboardId: found.id };
  const created = await api.post('/v1/gameCenterLeaderboards', { data: { type: 'gameCenterLeaderboards', attributes: { vendorIdentifier, ...attributes },
    relationships: { gameCenterDetail: rel('gameCenterDetails', gameCenter.id) } } });
  return { status: 'created' as const, leaderboardId: created.id };
}
export async function updateLeaderboard(input: { account: Account; appId: string; leaderboardId: string } & LeaderboardFields, api: GameCenterAPI) {
  const { account, appId, leaderboardId, ...fields } = input;
  requireWrite(account, appId);
  const attributes = leaderboardAttributes(fields);
  if (!Object.keys(attributes).length) throw new Error('Provide a field to change.');
  const { leaderboard } = await ownedLeaderboard(api, appId, leaderboardId);
  const changes = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => leaderboard.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, leaderboardId };
  await api.patch(`/v1/gameCenterLeaderboards/${leaderboardId}`, 'gameCenterLeaderboards', leaderboardId, changes);
  return { status: 'updated' as const, leaderboardId, changed: Object.keys(changes) };
}
async function upsertLocale(api: GameCenterAPI, rows: Resource[], locale: string, resource: string, fields: Record<string, unknown>, parent: Record<string, unknown>) {
  const existing = rows.find(row => row.attributes.locale === locale);
  const wanted = clean(fields);
  if (!existing) return { status: 'created' as const, id: (await api.post(`/v1/${resource}`, { data: { type: resource, attributes: { locale, ...wanted }, relationships: parent } })).id };
  const changes = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => existing.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, id: existing.id };
  await api.patch(`/v1/${resource}/${existing.id}`, resource, existing.id, changes);
  return { status: 'updated' as const, id: existing.id, changed: Object.keys(changes) };
}
/** Leaderboard name is limited to 64 characters; suffixes name the score unit, e.g. "points" and "point". */
export async function localizeLeaderboard(input: { account: Account; appId: string; leaderboardId: string; locale: string; name?: string; description?: string; formatterSuffix?: string; formatterSuffixSingular?: string; formatterOverride?: string }, api: GameCenterAPI) {
  const { account, appId, leaderboardId, locale, ...fields } = input;
  requireWrite(account, appId); checkLocale(locale);
  chars(fields.name, 64, 'Leaderboard name'); chars(fields.description, 200, 'Description');
  if (fields.formatterOverride !== undefined && !FORMATTERS.includes(fields.formatterOverride)) throw new Error('Unknown formatter override.');
  await ownedLeaderboard(api, appId, leaderboardId);
  const rows = await all(api, `/v1/gameCenterLeaderboards/${leaderboardId}/localizations?limit=200`);
  if (!rows.some(row => row.attributes.locale === locale) && !fields.name) throw new Error(`Locale ${locale} is new; --name is required.`);
  return upsertLocale(api, rows, locale, 'gameCenterLeaderboardLocalizations', fields, { gameCenterLeaderboard: rel('gameCenterLeaderboards', leaderboardId) });
}

// ---- Achievements ----
const achievements = async (api: GameCenterAPI, gameCenterId: string) => all(api, `/v1/gameCenterDetails/${gameCenterId}/gameCenterAchievements?limit=200`);
async function ownedAchievement(api: GameCenterAPI, appId: string, achievementId: string): Promise<{ gameCenterId: string; achievement: Resource; others: Resource[] }> {
  if (!validId(achievementId)) throw new Error('Invalid achievement ID.');
  const gameCenter = await detail(api, appId);
  const rows = await achievements(api, gameCenter.id);
  const achievement = rows.find(row => row.id === achievementId);
  if (!achievement) throw new Error('Achievement does not belong to this app.');
  return { gameCenterId: gameCenter.id, achievement, others: rows.filter(row => row.id !== achievementId) };
}
/** Apple caps one achievement at 100 points and a game at 1000 across unarchived achievements. */
function checkPoints(points: number, others: Resource[]): void {
  if (!Number.isInteger(points) || points < 1 || points > 100) throw new Error('Points must be a whole number from 1 to 100.');
  const used = others.filter(row => row.attributes.archived !== true).reduce((sum, row) => sum + Number(row.attributes.points ?? 0), 0);
  if (used + points > 1000) throw new Error(`This would make ${used + points} points; a game may have at most 1000. ${1000 - used} left.`);
}
export async function createAchievement(input: { account: Account; appId: string; vendorIdentifier: string; referenceName: string; points: number; showBeforeEarned: boolean; repeatable: boolean }, api: GameCenterAPI) {
  const { account, appId, vendorIdentifier, referenceName, points, showBeforeEarned, repeatable } = input;
  requireWrite(account, appId); vendorId(vendorIdentifier); chars(referenceName, 64, 'Reference name');
  if (!referenceName.trim()) throw new Error('Reference name is required.');
  const gameCenter = await detail(api, appId);
  const rows = await achievements(api, gameCenter.id);
  const found = rows.find(row => row.attributes.vendorIdentifier === vendorIdentifier);
  if (found) return { status: 'exists' as const, achievementId: found.id };
  checkPoints(points, rows);
  const created = await api.post('/v1/gameCenterAchievements', { data: { type: 'gameCenterAchievements', attributes: { vendorIdentifier, referenceName, points, showBeforeEarned, repeatable },
    relationships: { gameCenterDetail: rel('gameCenterDetails', gameCenter.id) } } });
  return { status: 'created' as const, achievementId: created.id };
}
export async function updateAchievement(input: { account: Account; appId: string; achievementId: string; referenceName?: string; points?: number; showBeforeEarned?: boolean; repeatable?: boolean; archived?: boolean }, api: GameCenterAPI) {
  const { account, appId, achievementId, ...fields } = input;
  requireWrite(account, appId); chars(fields.referenceName, 64, 'Reference name');
  const attributes = clean(fields);
  if (!Object.keys(attributes).length) throw new Error('Provide a field to change.');
  const { achievement, others } = await ownedAchievement(api, appId, achievementId);
  if (fields.points !== undefined) checkPoints(fields.points, others);
  const changes = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => achievement.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, achievementId };
  await api.patch(`/v1/gameCenterAchievements/${achievementId}`, 'gameCenterAchievements', achievementId, changes);
  return { status: 'updated' as const, achievementId, changed: Object.keys(changes) };
}
/** Achievement title 30 and descriptions 200 characters. */
export async function localizeAchievement(input: { account: Account; appId: string; achievementId: string; locale: string; name?: string; beforeEarnedDescription?: string; afterEarnedDescription?: string }, api: GameCenterAPI) {
  const { account, appId, achievementId, locale, ...fields } = input;
  requireWrite(account, appId); checkLocale(locale);
  chars(fields.name, 30, 'Achievement title'); chars(fields.beforeEarnedDescription, 200, 'Before-earned description'); chars(fields.afterEarnedDescription, 200, 'After-earned description');
  await ownedAchievement(api, appId, achievementId);
  const rows = await all(api, `/v1/gameCenterAchievements/${achievementId}/localizations?limit=200`);
  if (!rows.some(row => row.attributes.locale === locale) && !(fields.name && fields.beforeEarnedDescription && fields.afterEarnedDescription)) throw new Error(`Locale ${locale} is new; --name, --before and --after are required.`);
  return upsertLocale(api, rows, locale, 'gameCenterAchievementLocalizations', fields, { gameCenterAchievement: rel('gameCenterAchievements', achievementId) });
}

// ---- Images ----
/** Uploads the image for one language of a leaderboard or achievement, replacing the previous one after the new one commits. */
export async function uploadGameCenterImage(input: { account: Account; appId: string; kind: 'leaderboard' | 'achievement'; itemId: string; locale: string; filePath: string }, api: GameCenterAPI, fetcher: typeof fetch = fetch) {
  const { account, appId, kind, itemId, locale, filePath } = input;
  requireWrite(account, appId); checkLocale(locale);
  const { name, bytes } = await readImage(filePath);
  const spec = kind === 'leaderboard'
    ? { owned: () => ownedLeaderboard(api, appId, itemId), list: `/v1/gameCenterLeaderboards/${itemId}/localizations?limit=200`, image: 'gameCenterLeaderboardImages', current: (id: string) => `/v1/gameCenterLeaderboardLocalizations/${id}/gameCenterLeaderboardImage`, relation: 'gameCenterLeaderboardLocalization', localizationType: 'gameCenterLeaderboardLocalizations' }
    : { owned: () => ownedAchievement(api, appId, itemId), list: `/v1/gameCenterAchievements/${itemId}/localizations?limit=200`, image: 'gameCenterAchievementImages', current: (id: string) => `/v1/gameCenterAchievementLocalizations/${id}/gameCenterAchievementImage`, relation: 'gameCenterAchievementLocalization', localizationType: 'gameCenterAchievementLocalizations' };
  await spec.owned();
  const localization = (await all(api, spec.list)).find(row => row.attributes.locale === locale);
  if (!localization) throw new Error(`Add the ${locale} language first.`);
  const previous = await optional(api, spec.current(localization.id));
  let reserved: Resource;
  const body = { data: { type: spec.image, attributes: { fileName: name, fileSize: bytes.length }, relationships: { [spec.relation]: rel(spec.localizationType, localization.id) } } };
  let removedFirst = false;
  try { reserved = await api.post(`/v1/${spec.image}`, body); }
  catch (error) {
    // A language holds one image; if Apple refuses a second, remove the old one and try once more.
    if (!(error instanceof AppleError) || error.status !== 409 || !previous) throw error;
    await api.delete(`/v1/${spec.image}/${previous.id}`);
    removedFirst = true;
    reserved = await api.post(`/v1/${spec.image}`, body);
  }
  for (const op of validateOperations(reserved.attributes.uploadOperations, bytes.length)) await putFilePart(op, filePath, fetcher);
  await api.patch(`/v1/${spec.image}/${reserved.id}`, spec.image, reserved.id, { uploaded: true });
  if (previous && !removedFirst && previous.id !== reserved.id) await api.delete(`/v1/${spec.image}/${previous.id}`);
  return { status: 'uploaded' as const, imageId: reserved.id, replaced: previous?.id ?? null };
}

// ---- Releases ----
/** Makes a leaderboard or achievement live for players. Needs an approved app version with Game Center. */
export async function releaseGameCenterItem(input: { account: Account; appId: string; kind: 'leaderboard' | 'achievement'; itemId: string }, api: GameCenterAPI) {
  const { account, appId, kind, itemId } = input;
  requireWrite(account, appId);
  const { gameCenterId } = kind === 'leaderboard' ? await ownedLeaderboard(api, appId, itemId) : await ownedAchievement(api, appId, itemId);
  const releases = kind === 'leaderboard' ? 'leaderboardReleases' : 'achievementReleases';
  const filter = kind === 'leaderboard' ? 'filter[gameCenterLeaderboard]' : 'filter[gameCenterAchievement]';
  const existing = (await all(api, `/v1/gameCenterDetails/${gameCenterId}/${releases}?${new URLSearchParams({ [filter]: itemId, limit: '50' })}`))[0];
  if (existing) return { status: 'already_released' as const, releaseId: existing.id, live: existing.attributes.live };
  const resource = kind === 'leaderboard' ? 'gameCenterLeaderboardReleases' : 'gameCenterAchievementReleases';
  const item = kind === 'leaderboard' ? { gameCenterLeaderboard: rel('gameCenterLeaderboards', itemId) } : { gameCenterAchievement: rel('gameCenterAchievements', itemId) };
  const created = await api.post(`/v1/${resource}`, { data: { type: resource, relationships: { gameCenterDetail: rel('gameCenterDetails', gameCenterId), ...item } } });
  return { status: 'released' as const, releaseId: created.id };
}
