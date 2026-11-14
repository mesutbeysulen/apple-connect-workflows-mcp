import { requireAccountWrite, requireWrite, type Account } from './config.js';
import { AppleError, type Method, type Resource } from './apple.js';
import { EDITABLE_VERSION_STATES, validId, versionOfApp } from './apple-rules.js';
import { imageInfo } from './creative-assets.js';
import { readImage } from './screenshots.js';
import { putFilePart, validateOperations } from './upload-transfer.js';
import { submitForReview, type ReviewAPI, type ReviewItem } from './review.js';

export interface GameCenterAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<void>;
}
const rel = (type: string, id: string) => ({ data: { type, id } });
const clean = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
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

/**
 * Apple's current, versioned Game Center model. Each item owns versions; text and images belong to a version,
 * and a version goes live through App Review. Paths and relationship names follow App Store Connect API 4.6.
 */
export type GameCenterKind = 'leaderboard' | 'achievement' | 'leaderboard-set' | 'activity' | 'challenge';
interface KindSpec {
  base: string; type: string; list: string; versionType: string; versionInlineRelation: string; versionBase: string;
  localization: string; localizationType: string; image: string; imageOwner: 'localization' | 'version-or-localization';
  imageSize?: { width: number; height: number; opaque?: boolean }; reviewRelation: ReviewItem['relation']; release?: string; textFields: string[]; required: string[];
}
const KINDS: Record<GameCenterKind, KindSpec> = {
  // Image specs from App Store Connect Help: leaderboards and achievements 1024x1024; activities and challenges 3840x2160 without transparency.
  leaderboard: { base: '/v2/gameCenterLeaderboards', type: 'gameCenterLeaderboards', list: 'gameCenterLeaderboards', versionType: 'gameCenterLeaderboardVersions', versionInlineRelation: 'leaderboard', versionBase: '/v2/gameCenterLeaderboardVersions',
    localization: '/v2/gameCenterLeaderboardLocalizations', localizationType: 'gameCenterLeaderboardLocalizations', image: '/v2/gameCenterLeaderboardImages', imageOwner: 'localization',
    imageSize: { width: 1024, height: 1024 }, reviewRelation: 'gameCenterLeaderboardVersion', textFields: ['name', 'description', 'formatterSuffix', 'formatterSuffixSingular', 'formatterOverride'], required: ['name'] },
  achievement: { base: '/v2/gameCenterAchievements', type: 'gameCenterAchievements', list: 'gameCenterAchievements', versionType: 'gameCenterAchievementVersions', versionInlineRelation: 'achievement', versionBase: '/v2/gameCenterAchievementVersions',
    localization: '/v2/gameCenterAchievementLocalizations', localizationType: 'gameCenterAchievementLocalizations', image: '/v2/gameCenterAchievementImages', imageOwner: 'localization',
    imageSize: { width: 1024, height: 1024 }, reviewRelation: 'gameCenterAchievementVersion', textFields: ['name', 'beforeEarnedDescription', 'afterEarnedDescription'], required: ['name', 'beforeEarnedDescription', 'afterEarnedDescription'] },
  'leaderboard-set': { base: '/v2/gameCenterLeaderboardSets', type: 'gameCenterLeaderboardSets', list: 'gameCenterLeaderboardSets', versionType: 'gameCenterLeaderboardSetVersions', versionInlineRelation: 'leaderboardSet', versionBase: '/v2/gameCenterLeaderboardSetVersions',
    localization: '/v2/gameCenterLeaderboardSetLocalizations', localizationType: 'gameCenterLeaderboardSetLocalizations', image: '/v2/gameCenterLeaderboardSetImages', imageOwner: 'localization',
    reviewRelation: 'gameCenterLeaderboardSetVersion', textFields: ['name'], required: ['name'] },
  activity: { base: '/v1/gameCenterActivities', type: 'gameCenterActivities', list: 'gameCenterActivities', versionType: 'gameCenterActivityVersions', versionInlineRelation: 'activity', versionBase: '/v1/gameCenterActivityVersions',
    localization: '/v1/gameCenterActivityLocalizations', localizationType: 'gameCenterActivityLocalizations', image: '/v1/gameCenterActivityImages', imageOwner: 'version-or-localization',
    imageSize: { width: 3840, height: 2160, opaque: true }, reviewRelation: 'gameCenterActivityVersion', release: '/v1/gameCenterActivityVersionReleases', textFields: ['name', 'description'], required: ['name'] },
  challenge: { base: '/v1/gameCenterChallenges', type: 'gameCenterChallenges', list: 'gameCenterChallenges', versionType: 'gameCenterChallengeVersions', versionInlineRelation: 'challenge', versionBase: '/v1/gameCenterChallengeVersions',
    localization: '/v1/gameCenterChallengeLocalizations', localizationType: 'gameCenterChallengeLocalizations', image: '/v1/gameCenterChallengeImages', imageOwner: 'version-or-localization',
    imageSize: { width: 3840, height: 2160, opaque: true }, reviewRelation: 'gameCenterChallengeVersion', release: '/v1/gameCenterChallengeVersionReleases', textFields: ['name', 'description'], required: ['name'] },
};
export const GAME_CENTER_KINDS = Object.keys(KINDS) as GameCenterKind[];
const spec = (kind: string): KindSpec => { const found = KINDS[kind as GameCenterKind]; if (!found) throw new Error(`Kind must be one of ${GAME_CENTER_KINDS.join(', ')}.`); return found; };
/** Versions that already went to Apple cannot be edited; a new version is needed for changes. */
const LOCKED = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED', 'APPROVED', 'LIVE', 'READY_FOR_DISTRIBUTION']);
const versionState = (row: Resource) => String(row.attributes.state ?? row.attributes.versionState ?? 'UNKNOWN');

/** Identifiers are permanent. Apple allows up to 100 single-byte characters; challenges may also contain spaces. */
function checkVendorId(kind: GameCenterKind, value: string): void {
  const pattern = kind === 'challenge' ? /^[A-Za-z0-9._ -]{1,100}$/ : /^[A-Za-z0-9._-]{1,100}$/;
  if (!pattern.test(value)) throw new Error('Identifier must be 1-100 letters, digits, dots, dashes or underscores. It can never change.');
}
export const FORMATTERS = ['INTEGER', 'DECIMAL_POINT_1_PLACE', 'DECIMAL_POINT_2_PLACE', 'DECIMAL_POINT_3_PLACE', 'ELAPSED_TIME_CENTISECOND', 'ELAPSED_TIME_MINUTE', 'ELAPSED_TIME_SECOND',
  'MONEY_POUND_DECIMAL', 'MONEY_POUND', 'MONEY_DOLLAR_DECIMAL', 'MONEY_DOLLAR', 'MONEY_EURO_DECIMAL', 'MONEY_EURO', 'MONEY_FRANC_DECIMAL', 'MONEY_FRANC', 'MONEY_KRONER_DECIMAL', 'MONEY_KRONER', 'MONEY_YEN'];
const INT64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };
export interface ItemFields {
  referenceName?: string; archived?: boolean;
  // leaderboard
  formatter?: string; scoreSortType?: string; submissionType?: string; scoreRangeStart?: string; scoreRangeEnd?: string; visibility?: string;
  recurrenceStartDate?: string; recurrenceDuration?: string; recurrenceRule?: string;
  // achievement
  points?: number; showBeforeEarned?: boolean; repeatable?: boolean;
  // activity
  playStyle?: string; minimumPlayersCount?: number; maximumPlayersCount?: number; supportsPartyCode?: boolean; properties?: Record<string, string>;
}
const FIELDS_BY_KIND: Record<GameCenterKind, string[]> = {
  leaderboard: ['referenceName', 'archived', 'formatter', 'scoreSortType', 'submissionType', 'scoreRangeStart', 'scoreRangeEnd', 'visibility', 'recurrenceStartDate', 'recurrenceDuration', 'recurrenceRule'],
  achievement: ['referenceName', 'archived', 'points', 'showBeforeEarned', 'repeatable'],
  'leaderboard-set': ['referenceName'],
  activity: ['referenceName', 'archived', 'playStyle', 'minimumPlayersCount', 'maximumPlayersCount', 'supportsPartyCode', 'properties'],
  challenge: ['referenceName', 'archived', 'repeatable'],
};
/** Validates only what Apple documents; text lengths Apple does not publish are left to Apple. */
function attributes(kind: GameCenterKind, fields: ItemFields): Record<string, unknown> {
  const unknown = Object.entries(fields).filter(([key, value]) => value !== undefined && !FIELDS_BY_KIND[kind].includes(key)).map(([key]) => key);
  if (unknown.length) throw new Error(`${unknown.join(', ')} do not apply to ${kind}.`);
  if (fields.formatter !== undefined && !FORMATTERS.includes(fields.formatter)) throw new Error(`Formatter must be one of ${FORMATTERS.join(', ')}.`);
  if (fields.scoreSortType !== undefined && !['ASC', 'DESC'].includes(fields.scoreSortType)) throw new Error('Sort must be ASC or DESC.');
  if (fields.submissionType !== undefined && !['BEST_SCORE', 'MOST_RECENT_SCORE'].includes(fields.submissionType)) throw new Error('Submission must be BEST_SCORE or MOST_RECENT_SCORE.');
  if (fields.visibility !== undefined && !['SHOW_FOR_ALL', 'HIDE_FOR_ALL'].includes(fields.visibility)) throw new Error('Visibility must be SHOW_FOR_ALL or HIDE_FOR_ALL.');
  // Scores are 64-bit signed integers; Apple requires both range ends together and different from each other.
  if ((fields.scoreRangeStart === undefined) !== (fields.scoreRangeEnd === undefined)) throw new Error('Give both --range-start and --range-end.');
  for (const value of [fields.scoreRangeStart, fields.scoreRangeEnd]) if (value !== undefined && (!/^-?\d{1,19}$/.test(value) || BigInt(value) < INT64.min || BigInt(value) > INT64.max)) throw new Error('Score range values must be 64-bit whole numbers.');
  if (fields.scoreRangeStart !== undefined && BigInt(fields.scoreRangeStart) === BigInt(fields.scoreRangeEnd!)) throw new Error('Score range start and end must differ.');
  const recurring = [fields.recurrenceStartDate, fields.recurrenceDuration, fields.recurrenceRule];
  if (recurring.some(v => v !== undefined) && recurring.some(v => v === undefined)) throw new Error('A recurring leaderboard needs --recurrence-start, --recurrence-duration and --recurrence-rule together.');
  if (fields.recurrenceStartDate !== undefined && !(/T.*(Z|[+-]\d{2}:?\d{2})$/.test(fields.recurrenceStartDate) && Number.isFinite(Date.parse(fields.recurrenceStartDate)))) throw new Error('Recurrence start must be an ISO time with a time zone, e.g. 2027-01-05T00:00:00Z.');
  if (fields.recurrenceDuration !== undefined && !/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/.test(fields.recurrenceDuration)) throw new Error('Recurrence duration must be an ISO 8601 duration such as P7D or PT12H.');
  if (fields.recurrenceRule !== undefined && !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(fields.recurrenceRule)) throw new Error('Recurrence rule must be an RRULE such as FREQ=WEEKLY;INTERVAL=1.');
  if (fields.points !== undefined && (!Number.isInteger(fields.points) || fields.points < 1 || fields.points > 100)) throw new Error('Points must be a whole number from 1 to 100.');
  if (fields.playStyle !== undefined && !['ASYNCHRONOUS', 'SYNCHRONOUS'].includes(fields.playStyle)) throw new Error('Play style must be ASYNCHRONOUS or SYNCHRONOUS.');
  for (const count of [fields.minimumPlayersCount, fields.maximumPlayersCount]) if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw new Error('Player counts must be whole numbers of at least 1.');
  if (fields.minimumPlayersCount !== undefined && fields.maximumPlayersCount !== undefined && fields.minimumPlayersCount > fields.maximumPlayersCount) throw new Error('Minimum players cannot exceed maximum players.');
  const { formatter, ...rest } = fields;
  return clean({ ...rest, defaultFormatter: formatter });
}
async function items(api: GameCenterAPI, kind: GameCenterKind, gameCenterId: string): Promise<Resource[]> {
  return all(api, `/v1/gameCenterDetails/${gameCenterId}/${spec(kind).list}?limit=200`);
}
async function ownedItem(api: GameCenterAPI, appId: string, kind: GameCenterKind, id: string): Promise<{ gameCenterId: string; item: Resource; siblings: Resource[] }> {
  if (!validId(id)) throw new Error('Invalid ID.');
  const gameCenter = await detail(api, appId);
  const rows = await items(api, kind, gameCenter.id);
  const item = rows.find(row => row.id === id);
  if (!item) throw new Error(`${kind} does not belong to this app.`);
  return { gameCenterId: gameCenter.id, item, siblings: rows.filter(row => row.id !== id) };
}
/** Apple caps achievements at 1000 points per game across unarchived achievements. */
function checkPointBudget(points: number | undefined, others: Resource[]): void {
  if (points === undefined) return;
  const used = others.filter(row => row.attributes.archived !== true).reduce((sum, row) => sum + Number(row.attributes.points ?? 0), 0);
  if (used + points > 1000) throw new Error(`This would make ${used + points} points; a game may have at most 1000. ${1000 - used} left.`);
}
const REQUIRED_ON_CREATE: Partial<Record<GameCenterKind, (keyof ItemFields)[]>> = {
  leaderboard: ['formatter', 'scoreSortType', 'submissionType'], achievement: ['points', 'showBeforeEarned', 'repeatable'],
};
/** Creates an item together with its first version, or returns the item with the same identifier. */
export async function createItem(input: { account: Account; appId: string; kind: GameCenterKind; vendorIdentifier: string; referenceName: string; leaderboardId?: string } & ItemFields, api: GameCenterAPI) {
  const { account, appId, kind, vendorIdentifier, leaderboardId, ...fields } = input;
  requireWrite(account, appId);
  const s = spec(kind);
  checkVendorId(kind, vendorIdentifier);
  if (!fields.referenceName.trim()) throw new Error('Reference name is required.');
  const missing = (REQUIRED_ON_CREATE[kind] ?? []).filter(key => fields[key] === undefined);
  if (missing.length) throw new Error(`${kind} needs ${missing.join(', ')}.`);
  if ((kind === 'challenge') !== (leaderboardId !== undefined)) throw new Error(kind === 'challenge' ? 'A challenge is built on a leaderboard; pass --leaderboard.' : '--leaderboard applies only to challenges.');
  const attrs = attributes(kind, fields);
  const gameCenter = await detail(api, appId);
  const rows = await items(api, kind, gameCenter.id);
  const found = rows.find(row => row.attributes.vendorIdentifier === vendorIdentifier);
  if (found) return { status: 'exists' as const, id: found.id };
  if (kind === 'achievement') checkPointBudget(fields.points, rows);
  const relationships: Record<string, unknown> = { gameCenterDetail: rel('gameCenterDetails', gameCenter.id), versions: { data: [{ type: s.versionType, id: '${version}' }] } };
  if (kind === 'challenge') {
    if (!(await items(api, 'leaderboard', gameCenter.id)).some(row => row.id === leaderboardId)) throw new Error('Leaderboard does not belong to this app.');
    relationships.leaderboardV2 = rel('gameCenterLeaderboards', leaderboardId!);
  }
  const created = await api.post(s.base, { data: { type: s.type, attributes: { vendorIdentifier, ...attrs, ...(kind === 'challenge' ? { challengeType: 'LEADERBOARD' } : {}) }, relationships },
    included: [{ type: s.versionType, id: '${version}' }] });
  return { status: 'created' as const, id: created.id };
}
export async function updateItem(input: { account: Account; appId: string; kind: GameCenterKind; id: string } & ItemFields, api: GameCenterAPI) {
  const { account, appId, kind, id, ...fields } = input;
  requireWrite(account, appId);
  const attrs = attributes(kind, fields);
  if (!Object.keys(attrs).length) throw new Error('Provide a field to change.');
  const { item, siblings } = await ownedItem(api, appId, kind, id);
  // Points count while an achievement is unarchived, so restoring one or raising its points must fit the 1000 budget.
  const willCount = fields.archived === undefined ? item.attributes.archived !== true : !fields.archived;
  if (kind === 'achievement' && willCount && (fields.points !== undefined || (fields.archived === false && item.attributes.archived === true))) checkPointBudget(fields.points ?? Number(item.attributes.points ?? 0), siblings);
  const changes = Object.fromEntries(Object.entries(attrs).filter(([key, value]) => JSON.stringify(item.attributes[key]) !== JSON.stringify(value)));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, id };
  await api.patch(`${spec(kind).base}/${id}`, spec(kind).type, id, changes);
  return { status: 'updated' as const, id, changed: Object.keys(changes) };
}
async function versions(api: GameCenterAPI, kind: GameCenterKind, id: string): Promise<Resource[]> {
  return all(api, `${spec(kind).base}/${id}/versions?limit=200`);
}
/** Finds the version that can still be edited; with create, opens a new one when every version is locked. */
async function editableVersion(api: GameCenterAPI, kind: GameCenterKind, id: string, create: boolean): Promise<{ version: Resource; created: boolean }> {
  const editable = (await versions(api, kind, id)).find(row => !LOCKED.has(versionState(row)));
  if (editable) return { version: editable, created: false };
  if (!create) throw new Error(`Every version of this ${kind} is with Apple or live. Run gc-version-create to open a new one.`);
  const s = spec(kind);
  const version = await api.post(s.versionBase, { data: { type: s.versionType, relationships: { [s.versionInlineRelation]: rel(s.type, id) } } });
  return { version, created: true };
}
/** Opens a new editable version of a live item; returns the existing editable one instead if there is one. */
export async function createItemVersion(input: { account: Account; appId: string; kind: GameCenterKind; id: string }, api: GameCenterAPI) {
  const { account, appId, kind, id } = input;
  requireWrite(account, appId);
  await ownedItem(api, appId, kind, id);
  const { version, created } = await editableVersion(api, kind, id, true);
  return { status: created ? 'created' as const : 'exists' as const, versionId: version.id };
}
/** Adds or updates one language on the editable version. */
export async function localizeItem(input: { account: Account; appId: string; kind: GameCenterKind; id: string; locale: string; text: Record<string, string | undefined> }, api: GameCenterAPI) {
  const { account, appId, kind, id, locale, text } = input;
  requireWrite(account, appId); checkLocale(locale);
  const s = spec(kind);
  const extra = Object.entries(text).filter(([key, value]) => value !== undefined && !s.textFields.includes(key)).map(([key]) => key);
  if (extra.length) throw new Error(`${extra.join(', ')} do not apply to ${kind}.`);
  if (text.formatterOverride !== undefined && !FORMATTERS.includes(text.formatterOverride)) throw new Error('Unknown formatter override.');
  await ownedItem(api, appId, kind, id);
  const { version } = await editableVersion(api, kind, id, false);
  const rows = await all(api, `${s.versionBase}/${version.id}/localizations?limit=200`);
  const existing = rows.find(row => row.attributes.locale === locale);
  const wanted = clean(text);
  if (!existing) {
    const missing = s.required.filter(key => !wanted[key]);
    if (missing.length) throw new Error(`Locale ${locale} is new; it needs ${missing.join(', ')}.`);
    const created = await api.post(s.localization, { data: { type: s.localizationType, attributes: { locale, ...wanted }, relationships: { version: rel(s.versionType, version.id) } } });
    return { status: 'created' as const, localizationId: created.id, versionId: version.id };
  }
  const changes = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => existing.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, localizationId: existing.id, versionId: version.id };
  await api.patch(`${s.localization}/${existing.id}`, s.localizationType, existing.id, changes);
  return { status: 'updated' as const, localizationId: existing.id, versionId: version.id, changed: Object.keys(changes) };
}
/** Uploads an image for one language, or the default image of an activity or challenge version, checking Apple's pixel size first. */
export async function uploadItemImage(input: { account: Account; appId: string; kind: GameCenterKind; id: string; locale?: string; filePath: string }, api: GameCenterAPI, fetcher: typeof fetch = fetch) {
  const { account, appId, kind, id, locale, filePath } = input;
  requireWrite(account, appId);
  const s = spec(kind);
  if (locale === undefined && s.imageOwner === 'localization') throw new Error(`A ${kind} image belongs to a language; pass --locale.`);
  if (locale !== undefined) checkLocale(locale);
  const { name, bytes } = await readImage(filePath);
  if (s.imageSize) {
    const info = imageInfo(bytes);
    if (info.width !== s.imageSize.width || info.height !== s.imageSize.height) throw new Error(`${kind} images must be ${s.imageSize.width}x${s.imageSize.height} pixels; this one is ${info.width}x${info.height}.`);
    if (s.imageSize.opaque && info.hasAlpha) throw new Error(`${kind} images must not have transparency.`);
  }
  await ownedItem(api, appId, kind, id);
  const { version } = await editableVersion(api, kind, id, false);
  let owner: { relation: string; type: string; id: string; current: string };
  if (locale !== undefined) {
    const localization = (await all(api, `${s.versionBase}/${version.id}/localizations?limit=200`)).find(row => row.attributes.locale === locale);
    if (!localization) throw new Error(`Add the ${locale} language first with gc-localize.`);
    owner = { relation: 'localization', type: s.localizationType, id: localization.id, current: `${s.localization}/${localization.id}/image` };
  } else owner = { relation: 'version', type: s.versionType, id: version.id, current: `${s.versionBase}/${version.id}/defaultImage` };
  const previous = await optional(api, owner.current);
  const imageType = s.image.split('/').pop()!;
  const body = { data: { type: imageType, attributes: { fileName: name, fileSize: bytes.length }, relationships: { [owner.relation]: rel(owner.type, owner.id) } } };
  let reserved: Resource;
  let removedFirst = false;
  try { reserved = await api.post(s.image, body); }
  catch (error) {
    // Each owner holds one image; if Apple refuses a second, remove the old one and try once more.
    if (!(error instanceof AppleError) || error.status !== 409 || !previous) throw error;
    await api.delete(`${s.image}/${previous.id}`);
    removedFirst = true;
    reserved = await api.post(s.image, body);
  }
  for (const op of validateOperations(reserved.attributes.uploadOperations, bytes.length)) await putFilePart(op, filePath, fetcher);
  await api.patch(`${s.image}/${reserved.id}`, imageType, reserved.id, { uploaded: true });
  if (previous && !removedFirst && previous.id !== reserved.id) await api.delete(`${s.image}/${previous.id}`);
  return { status: 'uploaded' as const, imageId: reserved.id, versionId: version.id, replaced: previous?.id ?? null };
}
/**
 * Sends the editable version to App Review, optionally with an App Store version. Activities and challenges are
 * first attached to Game Center with a version release, as Apple's API guide describes.
 */
export async function submitItem(input: { account: Account; appId: string; kind: GameCenterKind; id: string; appVersionId?: string }, api: GameCenterAPI & ReviewAPI) {
  const { account, appId, kind, id, appVersionId } = input;
  requireWrite(account, appId);
  const s = spec(kind);
  const { gameCenterId } = await ownedItem(api, appId, kind, id);
  const { version } = await editableVersion(api, kind, id, false);
  if (!(await all(api, `${s.versionBase}/${version.id}/localizations?limit=200`)).length) throw new Error('Add at least one language before submitting.');
  if (appVersionId) await versionOfApp(api, appId, appVersionId);
  if (s.release) {
    const releases = await all(api, `/v1/gameCenterDetails/${gameCenterId}/${kind === 'activity' ? 'activityReleases' : 'challengeReleases'}?limit=200&include=version`);
    const attached = releases.some(row => { const data = row.relationships?.version?.data; return data && !Array.isArray(data) && data.id === version.id; });
    if (!attached) await api.post(s.release, { data: { type: s.release.split('/').pop()!, relationships: { gameCenterDetail: rel('gameCenterDetails', gameCenterId), version: rel(s.versionType, version.id) } } });
  }
  const reviewItems: ReviewItem[] = [{ relation: s.reviewRelation, id: version.id }, ...(appVersionId ? [{ relation: 'appStoreVersion' as const, id: appVersionId }] : [])];
  return { versionId: version.id, ...await submitForReview({ account, appId, items: reviewItems }, api) };
}

// ---- Relationships between items ----
/** Replaces the leaderboards inside a leaderboard set. */
export async function setLeaderboardSetMembers(input: { account: Account; appId: string; setId: string; leaderboardIds: string[] }, api: GameCenterAPI) {
  const { account, appId, setId } = input;
  requireWrite(account, appId);
  const leaderboardIds = [...new Set(input.leaderboardIds)];
  if (!leaderboardIds.length) throw new Error('Provide at least one leaderboard.');
  const { gameCenterId } = await ownedItem(api, appId, 'leaderboard-set', setId);
  const known = new Set((await items(api, 'leaderboard', gameCenterId)).map(row => row.id));
  const foreign = leaderboardIds.filter(id => !known.has(id));
  if (foreign.length) throw new Error(`Leaderboards not in this app: ${foreign.join(', ')}.`);
  const current = (await all(api, `/v2/gameCenterLeaderboardSets/${setId}/gameCenterLeaderboards?limit=200`)).map(row => row.id);
  if (current.length === leaderboardIds.length && leaderboardIds.every(id => current.includes(id))) return { status: 'unchanged' as const, setId, leaderboards: current };
  await api.request('PATCH', `/v2/gameCenterLeaderboardSets/${setId}/relationships/gameCenterLeaderboards`, { data: leaderboardIds.map(id => ({ type: 'gameCenterLeaderboards', id })) });
  return { status: 'updated' as const, setId, leaderboards: leaderboardIds };
}
/** Links a leaderboard or achievement to an activity, so finishing the activity can show it. */
export async function linkToActivity(input: { account: Account; appId: string; kind: 'leaderboard' | 'achievement'; id: string; activityId: string | null }, api: GameCenterAPI) {
  const { account, appId, kind, id, activityId } = input;
  requireWrite(account, appId);
  const { gameCenterId } = await ownedItem(api, appId, kind, id);
  if (activityId !== null && !(await items(api, 'activity', gameCenterId)).some(row => row.id === activityId)) throw new Error('Activity does not belong to this app.');
  await api.request('PATCH', `${spec(kind).base}/${id}/relationships/activity`, { data: activityId === null ? null : { type: 'gameCenterActivities', id: activityId } });
  return { id, activityId };
}
/** Chooses which leaderboard Game Center shows first for the game. */
export async function setDefaultLeaderboard(input: { account: Account; appId: string; leaderboardId: string }, api: GameCenterAPI) {
  const { account, appId, leaderboardId } = input;
  requireWrite(account, appId);
  const { gameCenterId } = await ownedItem(api, appId, 'leaderboard', leaderboardId);
  await api.request('PATCH', `/v1/gameCenterDetails/${gameCenterId}`, { data: { type: 'gameCenterDetails', id: gameCenterId, relationships: { defaultLeaderboardV2: rel('gameCenterLeaderboards', leaderboardId) } } });
  return { gameCenterId, defaultLeaderboard: leaderboardId };
}

// ---- Groups (share Game Center data between apps) ----
export async function createGroup(input: { account: Account; referenceName: string }, api: GameCenterAPI) {
  const { account, referenceName } = input;
  requireAccountWrite(account);
  if (!referenceName.trim()) throw new Error('Reference name is required.');
  const found = (await all(api, '/v1/gameCenterGroups?limit=200')).find(row => row.attributes.referenceName === referenceName);
  if (found) return { status: 'exists' as const, groupId: found.id };
  return { status: 'created' as const, groupId: (await api.post('/v1/gameCenterGroups', { data: { type: 'gameCenterGroups', attributes: { referenceName } } })).id };
}
/** Moves an app's Game Center into a group so several apps share leaderboards and achievements. Hard to reverse. */
export async function joinGroup(input: { account: Account; appId: string; groupId: string; execute?: boolean }, api: GameCenterAPI) {
  const { account, appId, groupId, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validId(groupId)) throw new Error('Invalid group ID.');
  const gameCenter = await detail(api, appId);
  const group = await api.get(`/v1/gameCenterGroups/${groupId}`);
  const preview = { dryRun: !execute, appId, gameCenterId: gameCenter.id, groupId, groupName: group.attributes.referenceName,
    effect: 'Moves this app\'s Game Center into the group. Apple limits moving it out again; read Game Center groups in App Store Connect Help first.' };
  if (!execute) return preview;
  await api.request('PATCH', `/v1/gameCenterDetails/${gameCenter.id}`, { data: { type: 'gameCenterDetails', id: gameCenter.id, relationships: { gameCenterGroup: rel('gameCenterGroups', groupId) } } });
  return { ...preview, status: 'joined' as const };
}

// ---- Matchmaking (team level) ----
async function byName(api: GameCenterAPI, path: string, referenceName: string): Promise<Resource | undefined> {
  return (await all(api, path)).find(row => row.attributes.referenceName === referenceName);
}
const checkPlayers = (min: number, max: number) => {
  if (![min, max].every(n => Number.isInteger(n) && n >= 1) || min > max) throw new Error('Player counts must be whole numbers of at least 1, with minimum not above maximum.');
};
export async function createRuleSet(input: { account: Account; referenceName: string; minPlayers: number; maxPlayers: number; ruleLanguageVersion?: number }, api: GameCenterAPI) {
  const { account, referenceName, minPlayers, maxPlayers, ruleLanguageVersion = 1 } = input;
  requireAccountWrite(account); checkPlayers(minPlayers, maxPlayers);
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(referenceName)) throw new Error('Reference name may use letters, digits, dots, dashes and underscores.');
  if (!Number.isInteger(ruleLanguageVersion) || ruleLanguageVersion < 1) throw new Error('Rule language version must be a positive whole number.');
  const found = await byName(api, '/v1/gameCenterMatchmakingRuleSets?limit=200', referenceName);
  if (found) return { status: 'exists' as const, ruleSetId: found.id };
  return { status: 'created' as const, ruleSetId: (await api.post('/v1/gameCenterMatchmakingRuleSets', { data: { type: 'gameCenterMatchmakingRuleSets', attributes: { referenceName, minPlayers, maxPlayers, ruleLanguageVersion } } })).id };
}
async function knownRuleSet(api: GameCenterAPI, ruleSetId: string): Promise<void> {
  if (!validId(ruleSetId)) throw new Error('Invalid rule set ID.');
  if (!(await all(api, '/v1/gameCenterMatchmakingRuleSets?limit=200')).some(row => row.id === ruleSetId)) throw new Error('Rule set not found on this team.');
}
export const RULE_TYPES = ['COMPATIBLE', 'DISTANCE', 'MATCH', 'TEAM'];
export async function createRule(input: { account: Account; ruleSetId: string; referenceName: string; type: string; expression: string; description: string; weight?: number }, api: GameCenterAPI) {
  const { account, ruleSetId, referenceName, type, expression, description, weight } = input;
  requireAccountWrite(account);
  if (!RULE_TYPES.includes(type)) throw new Error(`Rule type must be one of ${RULE_TYPES.join(', ')}.`);
  if (!expression.trim() || !description.trim() || !referenceName.trim()) throw new Error('Rule needs a reference name, expression and description.');
  if (weight !== undefined && !Number.isFinite(weight)) throw new Error('Weight must be a number.');
  await knownRuleSet(api, ruleSetId);
  const found = await byName(api, `/v1/gameCenterMatchmakingRuleSets/${ruleSetId}/rules?limit=200`, referenceName);
  if (found) return { status: 'exists' as const, ruleId: found.id };
  return { status: 'created' as const, ruleId: (await api.post('/v1/gameCenterMatchmakingRules', { data: { type: 'gameCenterMatchmakingRules', attributes: clean({ referenceName, type, expression, description, weight }),
    relationships: { ruleSet: rel('gameCenterMatchmakingRuleSets', ruleSetId) } } })).id };
}
export async function createTeam(input: { account: Account; ruleSetId: string; referenceName: string; minPlayers: number; maxPlayers: number }, api: GameCenterAPI) {
  const { account, ruleSetId, referenceName, minPlayers, maxPlayers } = input;
  requireAccountWrite(account); checkPlayers(minPlayers, maxPlayers);
  await knownRuleSet(api, ruleSetId);
  const found = await byName(api, `/v1/gameCenterMatchmakingRuleSets/${ruleSetId}/teams?limit=200`, referenceName);
  if (found) return { status: 'exists' as const, teamId: found.id };
  return { status: 'created' as const, teamId: (await api.post('/v1/gameCenterMatchmakingTeams', { data: { type: 'gameCenterMatchmakingTeams', attributes: { referenceName, minPlayers, maxPlayers },
    relationships: { ruleSet: rel('gameCenterMatchmakingRuleSets', ruleSetId) } } })).id };
}
export async function createQueue(input: { account: Account; ruleSetId: string; referenceName: string; classicBundleIds?: string[] }, api: GameCenterAPI) {
  const { account, ruleSetId, referenceName, classicBundleIds } = input;
  requireAccountWrite(account);
  if (classicBundleIds && !classicBundleIds.every(id => /^[A-Za-z0-9.-]{1,155}$/.test(id))) throw new Error('Classic matchmaking bundle IDs must be bundle identifiers.');
  await knownRuleSet(api, ruleSetId);
  const found = await byName(api, '/v1/gameCenterMatchmakingQueues?limit=200', referenceName);
  if (found) return { status: 'exists' as const, queueId: found.id };
  return { status: 'created' as const, queueId: (await api.post('/v1/gameCenterMatchmakingQueues', { data: { type: 'gameCenterMatchmakingQueues', attributes: clean({ referenceName, classicMatchmakingBundleIds: classicBundleIds }),
    relationships: { ruleSet: rel('gameCenterMatchmakingRuleSets', ruleSetId) } } })).id };
}
