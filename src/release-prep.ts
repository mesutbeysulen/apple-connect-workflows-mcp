import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { requireAccountWrite, requireWrite, type Account } from './config.js';
import { AppleError, type Method, type Resource } from './apple.js';
import { EDITABLE_VERSION_STATES, validId, versionOfApp } from './apple-rules.js';
import { assertValidBody } from './schema-check.js';
import { putFilePart, validateOperations } from './upload-transfer.js';

export interface PrepAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<void>;
}
export interface Upsert { status: 'created' | 'updated' | 'unchanged'; id: string; changed: string[] }
const rel = (type: string, id: string) => ({ data: { type, id } });
const needId = (...ids: string[]) => { if (!ids.every(validId)) throw new Error('Invalid ID.'); };
const clean = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const chars = (value: unknown, max: number, label: string) => { if (typeof value === 'string' && [...value].length > max) throw new Error(`${label} is limited to ${max} characters.`); };
const validUrl = (value: unknown, label: string) => {
  if (typeof value !== 'string') return;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== 'https:' && url?.protocol !== 'http:') throw new Error(`${label} must be a full web address.`);
};
async function optional(api: Pick<PrepAPI, 'get'>, path: string): Promise<Resource | undefined> {
  try { return (await api.get(path)) ?? undefined; }
  catch (error) { if (error instanceof AppleError && error.status === 404) return undefined; throw error; }
}
async function ownedVersion(api: PrepAPI, appId: string, versionId: string): Promise<Resource> {
  needId(appId, versionId);
  return versionOfApp(api, appId, versionId);
}
async function ownedBuild(api: PrepAPI, appId: string, buildId: string): Promise<Resource> {
  needId(appId, buildId);
  if ((await api.get(`/v1/builds/${buildId}/app`)).id !== appId) throw new Error('Build does not belong to the requested app.');
  return api.get(`/v1/builds/${buildId}`);
}
/** Only differing fields are sent, so a rerun writes nothing. */
async function upsert(api: PrepAPI, existing: Resource | undefined, resource: string, base: string, fields: Record<string, unknown>, create: () => unknown): Promise<Upsert> {
  const wanted = clean(fields);
  if (!existing) {
    const created = await api.post(`/${base}/${resource}`, create());
    return { status: 'created', id: created.id, changed: Object.keys(wanted) };
  }
  const changes = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => existing.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged', id: existing.id, changed: [] };
  await api.patch(`/${base}/${resource}/${existing.id}`, resource, existing.id, changes);
  return { status: 'updated', id: existing.id, changed: Object.keys(changes) };
}

// ---- App record and app information ----
export async function updateApp(input: { account: Account; appId: string; primaryLocale?: string; contentRights?: string }, api: PrepAPI): Promise<Upsert> {
  const { account, appId, primaryLocale, contentRights } = input;
  requireWrite(account, appId); needId(appId);
  const fields = clean({ primaryLocale, contentRightsDeclaration: contentRights });
  if (!Object.keys(fields).length) throw new Error('Provide --primary-locale or --content-rights.');
  if (contentRights && !['DOES_NOT_USE_THIRD_PARTY_CONTENT', 'USES_THIRD_PARTY_CONTENT'].includes(contentRights)) throw new Error('--content-rights must be DOES_NOT_USE_THIRD_PARTY_CONTENT or USES_THIRD_PARTY_CONTENT.');
  return upsert(api, await api.get(`/v1/apps/${appId}`), 'apps', 'v1', fields, () => { throw new Error('App records cannot be created through the API.'); });
}
async function editableAppInfo(api: PrepAPI, appId: string): Promise<Resource> {
  const infos = await api.list(`/v1/apps/${appId}/appInfos?limit=50`, 50);
  const info = infos.data.find(row => EDITABLE_VERSION_STATES.includes(String(row.attributes.state ?? row.attributes.appStoreState)));
  if (!info) throw new Error('This app has no editable app information. Create a new version first.');
  return info;
}
export interface AppInfoFields { name?: string; subtitle?: string; privacyPolicyUrl?: string; privacyChoicesUrl?: string; privacyPolicyText?: string }
export function checkAppInfoFields(fields: AppInfoFields): void {
  chars(fields.name, 30, 'Name'); chars(fields.subtitle, 30, 'Subtitle');
  validUrl(fields.privacyPolicyUrl, 'Privacy policy URL'); validUrl(fields.privacyChoicesUrl, 'Privacy choices URL');
}
/** Creates or updates app name, subtitle and privacy details for one language. */
export async function setAppInfo(input: { account: Account; appId: string; locale: string } & AppInfoFields, api: PrepAPI): Promise<Upsert> {
  const { account, appId, locale, ...fields } = input;
  requireWrite(account, appId); needId(appId); checkLocale(locale); checkAppInfoFields(fields);
  const info = await editableAppInfo(api, appId);
  const rows = await api.list(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`, 2000);
  if (rows.truncated) throw new Error('Incomplete app information locale list.');
  const existing = rows.data.find(row => row.attributes.locale === locale);
  if (!existing && !fields.name) throw new Error(`Locale ${locale} is new; --name is required to create it.`);
  return upsert(api, existing, 'appInfoLocalizations', 'v1', fields, () => ({ data: { type: 'appInfoLocalizations', attributes: { locale, ...clean({ ...fields }) }, relationships: { appInfo: rel('appInfos', info.id) } } }));
}
const CATEGORY = { primary: 'primaryCategory', primarySub1: 'primarySubcategoryOne', primarySub2: 'primarySubcategoryTwo', secondary: 'secondaryCategory', secondarySub1: 'secondarySubcategoryOne', secondarySub2: 'secondarySubcategoryTwo' } as const;
/** Sets App Store categories. Use IDs from app_categories_list. */
export async function setCategories(input: { account: Account; appId: string; categories: Partial<Record<keyof typeof CATEGORY, string>> }, api: PrepAPI): Promise<{ appInfoId: string; set: string[] }> {
  const { account, appId, categories } = input;
  requireWrite(account, appId); needId(appId);
  const entries = Object.entries(categories).filter(([, id]) => id);
  if (!entries.length) throw new Error('Provide at least --primary.');
  for (const [, id] of entries) if (!/^[A-Z0-9_]{2,64}$/.test(id!)) throw new Error(`Invalid category ID ${id}.`);
  const info = await editableAppInfo(api, appId);
  const body = { data: { type: 'appInfos', id: info.id, relationships: Object.fromEntries(entries.map(([key, id]) => [CATEGORY[key as keyof typeof CATEGORY], rel('appCategories', id!)])) } };
  await api.request('PATCH', `/v1/appInfos/${info.id}`, body);
  return { appInfoId: info.id, set: entries.map(([key]) => key) };
}
/** Answers the age rating questionnaire from a JSON file, checked against Apple's own schema. */
export async function setAgeRating(input: { account: Account; appId: string; filePath: string }, api: PrepAPI): Promise<{ id: string; answered: string[] }> {
  const { account, appId, filePath } = input;
  requireWrite(account, appId); needId(appId);
  if (!isAbsolute(filePath)) throw new Error('Use an absolute JSON file path.');
  let attributes: Record<string, unknown>;
  try { attributes = JSON.parse(await readFile(filePath, 'utf8')); } catch { throw new Error('Age rating file is missing or not valid JSON.'); }
  const info = await editableAppInfo(api, appId);
  const declaration = await optional(api, `/v1/appInfos/${info.id}/ageRatingDeclaration`);
  if (!declaration) throw new Error('Apple returned no age rating declaration for this app.');
  assertValidBody('AgeRatingDeclarationUpdateRequest', { data: { type: 'ageRatingDeclarations', id: declaration.id, attributes } });
  await api.patch(`/v1/ageRatingDeclarations/${declaration.id}`, 'ageRatingDeclarations', declaration.id, attributes);
  return { id: declaration.id, answered: Object.keys(attributes) };
}
/** Replaces where the app is sold. Previews unless execute is set. */
export async function setAvailability(input: { account: Account; appId: string; territories: string[]; availableInNewTerritories: boolean; execute?: boolean }, api: PrepAPI) {
  const { account, appId, territories, availableInNewTerritories, execute = false } = input;
  if (execute) requireWrite(account, appId);
  needId(appId);
  if (!territories.length || !territories.every(t => /^[A-Z]{3}$/.test(t))) throw new Error('Use three-letter territories such as USA,TUR.');
  const preview = { dryRun: !execute, appId, territories, availableInNewTerritories, effect: 'Sets the full list of territories where this app is available.' };
  if (!execute) return preview;
  const created = await api.post('/v2/appAvailabilities', { data: { type: 'appAvailabilities', attributes: { availableInNewTerritories },
    relationships: { app: rel('apps', appId), territoryAvailabilities: { data: territories.map(t => ({ type: 'territoryAvailabilities', id: `\${${t}}` })) } } },
    included: territories.map(t => ({ type: 'territoryAvailabilities', id: `\${${t}}`, attributes: { available: true }, relationships: { territory: rel('territories', t) } })) });
  return { ...preview, result: created.id };
}
/** Registers an App ID. This belongs to the team, not to one app. */
export async function createBundleId(input: { account: Account; identifier: string; name: string; platform: string }, api: PrepAPI): Promise<{ status: 'exists' | 'created'; id: string }> {
  const { account, identifier, name, platform } = input;
  requireAccountWrite(account);
  if (!/^[A-Za-z0-9.*-]{1,155}$/.test(identifier) || !name || !['IOS', 'MAC_OS', 'UNIVERSAL'].includes(platform)) throw new Error('Use a valid identifier, a name, and platform IOS, MAC_OS or UNIVERSAL.');
  const found = (await api.list(`/v1/bundleIds?${new URLSearchParams({ 'filter[identifier]': identifier, limit: '200' })}`, 200)).data.find(row => row.attributes.identifier === identifier);
  if (found) return { status: 'exists', id: found.id };
  return { status: 'created', id: (await api.post('/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier, name, platform } } })).id };
}

// ---- Version ----
export const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'];
const RELEASE_TYPES = ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'];
export interface VersionFields { copyright?: string; releaseType?: string; earliestReleaseDate?: string; versionString?: string }
function checkVersionFields(fields: VersionFields): void {
  if (fields.releaseType && !RELEASE_TYPES.includes(fields.releaseType)) throw new Error(`Release type must be one of ${RELEASE_TYPES.join(', ')}.`);
  if (fields.earliestReleaseDate && !Number.isFinite(Date.parse(fields.earliestReleaseDate))) throw new Error('Earliest release date must be an ISO date and time.');
  if (fields.earliestReleaseDate && fields.releaseType && fields.releaseType !== 'SCHEDULED') throw new Error('A release date needs release type SCHEDULED.');
  if (fields.versionString && !/^\d+(\.\d+){0,2}$/.test(fields.versionString)) throw new Error('Version string must look like 1.2.3.');
}
/** Creates a version, or returns the existing one with the same number and platform. */
export async function createVersion(input: { account: Account; appId: string; platform: string; versionString: string } & Omit<VersionFields, 'versionString'>, api: PrepAPI): Promise<{ status: 'exists' | 'created'; versionId: string; state?: unknown }> {
  const { account, appId, platform, versionString, ...fields } = input;
  requireWrite(account, appId); needId(appId); checkVersionFields({ ...fields, versionString });
  if (!PLATFORMS.includes(platform)) throw new Error(`Platform must be one of ${PLATFORMS.join(', ')}.`);
  const query = new URLSearchParams({ 'filter[platform]': platform, 'filter[versionString]': versionString, limit: '10' });
  const found = (await api.list(`/v1/apps/${appId}/appStoreVersions?${query}`, 10)).data[0];
  if (found) return { status: 'exists', versionId: found.id, state: found.attributes.appVersionState ?? found.attributes.appStoreState };
  const created = await api.post('/v1/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform, versionString, ...clean({ ...fields }) }, relationships: { app: rel('apps', appId) } } });
  return { status: 'created', versionId: created.id };
}
export async function updateVersion(input: { account: Account; appId: string; versionId: string } & VersionFields, api: PrepAPI): Promise<Upsert> {
  const { account, appId, versionId, ...fields } = input;
  requireWrite(account, appId); checkVersionFields(fields);
  if (!Object.keys(clean({ ...fields })).length) throw new Error('Provide a field to change.');
  return upsert(api, await ownedVersion(api, appId, versionId), 'appStoreVersions', 'v1', { ...fields }, () => { throw new Error('Version not found.'); });
}
/** Attaches a processed build to a version and reads the link back. */
export async function attachBuild(input: { account: Account; appId: string; versionId: string; buildId: string }, api: PrepAPI): Promise<{ status: 'attached' | 'already_attached'; buildId: string }> {
  const { account, appId, versionId, buildId } = input;
  requireWrite(account, appId);
  const version = await ownedVersion(api, appId, versionId);
  if (!EDITABLE_VERSION_STATES.includes(String(version.attributes.appStoreState))) throw new Error(`Version is not editable: ${version.attributes.appStoreState}`);
  const build = await ownedBuild(api, appId, buildId);
  if (build.attributes.processingState !== 'VALID' || build.attributes.expired === true) throw new Error(`Build is not ready: ${build.attributes.processingState ?? 'unknown'}${build.attributes.expired ? ', expired' : ''}.`);
  const current = await optional(api, `/v1/appStoreVersions/${versionId}/build`);
  if (current?.id === buildId) return { status: 'already_attached', buildId };
  await api.request('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, { data: { type: 'builds', id: buildId } });
  if ((await optional(api, `/v1/appStoreVersions/${versionId}/build`))?.id !== buildId) throw new Error('Apple has not confirmed the attached build. Check the version and retry.');
  return { status: 'attached', buildId };
}
/** Answers export compliance for a build, the question that otherwise blocks submission. */
export async function setBuildEncryption(input: { account: Account; appId: string; buildId: string; usesNonExemptEncryption: boolean }, api: PrepAPI): Promise<Upsert> {
  const { account, appId, buildId, usesNonExemptEncryption } = input;
  requireWrite(account, appId);
  return upsert(api, await ownedBuild(api, appId, buildId), 'builds', 'v1', { usesNonExemptEncryption }, () => { throw new Error('Build not found.'); });
}
export interface VersionLocaleFields { description?: string; keywords?: string; whatsNew?: string; promotionalText?: string; supportUrl?: string; marketingUrl?: string }
export function checkLocale(locale: string): void { if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new Error(`Invalid locale ${locale}.`); }
export function checkVersionLocaleFields(fields: VersionLocaleFields): void {
  chars(fields.description, 4000, 'Description'); chars(fields.whatsNew, 4000, 'Release notes'); chars(fields.promotionalText, 170, 'Promotional text');
  if (fields.keywords !== undefined && Buffer.byteLength(fields.keywords, 'utf8') > 100) throw new Error('Keywords are limited to 100 bytes.');
  validUrl(fields.supportUrl, 'Support URL'); validUrl(fields.marketingUrl, 'Marketing URL');
}
/** Adds a language to a version or updates its fields. */
export async function setVersionLocale(input: { account: Account; appId: string; versionId: string; locale: string } & VersionLocaleFields, api: PrepAPI): Promise<Upsert> {
  const { account, appId, versionId, locale, ...fields } = input;
  requireWrite(account, appId); checkLocale(locale); checkVersionLocaleFields(fields);
  await ownedVersion(api, appId, versionId);
  const rows = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (rows.truncated) throw new Error('Incomplete localization list.');
  const existing = rows.data.find(row => row.attributes.locale === locale);
  return upsert(api, existing, 'appStoreVersionLocalizations', 'v1', fields, () => ({ data: { type: 'appStoreVersionLocalizations', attributes: { locale, ...clean({ ...fields }) }, relationships: { appStoreVersion: rel('appStoreVersions', versionId) } } }));
}
export interface ReviewContact { contactFirstName?: string; contactLastName?: string; contactPhone?: string; contactEmail?: string; demoAccountRequired?: boolean; demoAccountName?: string; demoAccountPassword?: string; notes?: string }
/** Sets the App Review contact and test login. The password arrives from the environment, never as an argument. */
export async function setReviewDetail(input: { account: Account; appId: string; versionId: string } & ReviewContact, api: PrepAPI): Promise<Upsert> {
  const { account, appId, versionId, ...fields } = input;
  requireWrite(account, appId);
  await ownedVersion(api, appId, versionId);
  const existing = await optional(api, `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  return upsert(api, existing, 'appStoreReviewDetails', 'v1', fields, () => ({ data: { type: 'appStoreReviewDetails', attributes: clean({ ...fields }), relationships: { appStoreVersion: rel('appStoreVersions', versionId) } } }));
}
/** Uploads a file for App Review, such as a demo video, to this version's review details. */
export async function uploadReviewAttachment(input: { account: Account; appId: string; versionId: string; filePath: string }, api: PrepAPI, fetcher: typeof fetch = fetch): Promise<{ attachmentId: string; state: unknown }> {
  const { account, appId, versionId, filePath } = input;
  requireWrite(account, appId);
  if (!isAbsolute(filePath)) throw new Error('Use an absolute file path.');
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1) throw new Error('Attachment file is missing or empty.');
  await ownedVersion(api, appId, versionId);
  const detail = await optional(api, `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (!detail) throw new Error('Set the App Review contact first with review-detail-set.');
  const reserved = await api.post('/v1/appStoreReviewAttachments', { data: { type: 'appStoreReviewAttachments', attributes: { fileName: basename(filePath), fileSize: info.size }, relationships: { appStoreReviewDetail: rel('appStoreReviewDetails', detail.id) } } });
  for (const op of validateOperations(reserved.attributes.uploadOperations, info.size)) await putFilePart(op, filePath, fetcher);
  const md5 = createHash('md5').update(await readFile(filePath)).digest('hex');
  await api.patch(`/v1/appStoreReviewAttachments/${reserved.id}`, 'appStoreReviewAttachments', reserved.id, { uploaded: true, sourceFileChecksum: md5 });
  return { attachmentId: reserved.id, state: (await api.get(`/v1/appStoreReviewAttachments/${reserved.id}`)).attributes.assetDeliveryState };
}
const PHASED = ['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETE'];
/** Turns on, pauses, resumes or finishes the seven-day phased rollout. */
export async function setPhasedRelease(input: { account: Account; appId: string; versionId: string; state: string }, api: PrepAPI): Promise<Upsert> {
  const { account, appId, versionId, state } = input;
  requireWrite(account, appId);
  if (!PHASED.includes(state)) throw new Error(`State must be one of ${PHASED.join(', ')}.`);
  await ownedVersion(api, appId, versionId);
  const existing = await optional(api, `/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`);
  return upsert(api, existing, 'appStoreVersionPhasedReleases', 'v1', { phasedReleaseState: state }, () => ({ data: { type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: state }, relationships: { appStoreVersion: rel('appStoreVersions', versionId) } } }));
}
/** Cancels a review submission that is waiting or has unresolved issues. */
export async function cancelSubmission(input: { account: Account; appId: string; submissionId: string }, api: PrepAPI): Promise<{ submissionId: string; state: unknown }> {
  const { account, appId, submissionId } = input;
  requireWrite(account, appId); needId(appId, submissionId);
  const rows = await api.list(`/v1/apps/${appId}/reviewSubmissions?limit=200`, 2000);
  if (!rows.data.some(row => row.id === submissionId)) throw new Error('Review submission does not belong to this app.');
  await api.patch(`/v1/reviewSubmissions/${submissionId}`, 'reviewSubmissions', submissionId, { canceled: true });
  return { submissionId, state: (await api.get(`/v1/reviewSubmissions/${submissionId}`)).attributes.state };
}
/** Takes one item out of an unsent review draft so the rest can go on. */
export async function removeReviewItem(input: { account: Account; appId: string; submissionId: string; itemId: string }, api: PrepAPI): Promise<{ removed: string }> {
  const { account, appId, submissionId, itemId } = input;
  requireWrite(account, appId); needId(appId, submissionId, itemId);
  const rows = await api.list(`/v1/apps/${appId}/reviewSubmissions?limit=200`, 2000);
  if (!rows.data.some(row => row.id === submissionId)) throw new Error('Review submission does not belong to this app.');
  if (!(await api.list(`/v1/reviewSubmissions/${submissionId}/items?limit=200`, 2000)).data.some(row => row.id === itemId)) throw new Error('Item is not in this submission.');
  await api.delete(`/v1/reviewSubmissionItems/${itemId}`);
  return { removed: itemId };
}

// ---- TestFlight ----
export interface BetaAppFields { description?: string; feedbackEmail?: string; marketingUrl?: string; privacyPolicyUrl?: string }
export async function setBetaAppInfo(input: { account: Account; appId: string; locale: string } & BetaAppFields, api: PrepAPI): Promise<Upsert> {
  const { account, appId, locale, ...fields } = input;
  requireWrite(account, appId); needId(appId); checkLocale(locale);
  validUrl(fields.marketingUrl, 'Marketing URL'); validUrl(fields.privacyPolicyUrl, 'Privacy policy URL');
  const existing = (await api.list(`/v1/apps/${appId}/betaAppLocalizations?limit=200`, 2000)).data.find(row => row.attributes.locale === locale);
  return upsert(api, existing, 'betaAppLocalizations', 'v1', fields, () => ({ data: { type: 'betaAppLocalizations', attributes: { locale, ...clean({ ...fields }) }, relationships: { app: rel('apps', appId) } } }));
}
export async function setBetaBuildNotes(input: { account: Account; appId: string; buildId: string; locale: string; whatsNew: string }, api: PrepAPI): Promise<Upsert> {
  const { account, appId, buildId, locale, whatsNew } = input;
  requireWrite(account, appId); checkLocale(locale); chars(whatsNew, 4000, 'What to test');
  await ownedBuild(api, appId, buildId);
  const existing = (await api.list(`/v1/builds/${buildId}/betaBuildLocalizations?limit=200`, 200)).data.find(row => row.attributes.locale === locale);
  return upsert(api, existing, 'betaBuildLocalizations', 'v1', { whatsNew }, () => ({ data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew }, relationships: { build: rel('builds', buildId) } } }));
}
export async function setBetaReviewDetail(input: { account: Account; appId: string } & ReviewContact, api: PrepAPI): Promise<Upsert> {
  const { account, appId, ...fields } = input;
  requireWrite(account, appId); needId(appId);
  return upsert(api, await api.get(`/v1/apps/${appId}/betaAppReviewDetail`), 'betaAppReviewDetails', 'v1', fields, () => { throw new Error('Beta review detail not found.'); });
}
/** Sends a build to Beta App Review, which external testing requires. */
export async function submitBetaReview(input: { account: Account; appId: string; buildId: string }, api: PrepAPI): Promise<{ status: 'submitted' | 'already_submitted'; id: string; state?: unknown }> {
  const { account, appId, buildId } = input;
  requireWrite(account, appId);
  const build = await ownedBuild(api, appId, buildId);
  if (build.attributes.processingState !== 'VALID') throw new Error(`Build is not ready: ${build.attributes.processingState ?? 'unknown'}.`);
  const current = await optional(api, `/v1/builds/${buildId}/betaAppReviewSubmission`);
  if (current) return { status: 'already_submitted', id: current.id, state: current.attributes.betaReviewState };
  const created = await api.post('/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: rel('builds', buildId) } } });
  return { status: 'submitted', id: created.id, state: created.attributes?.betaReviewState };
}
export async function createBetaGroup(input: { account: Account; appId: string; name: string; publicLink?: boolean; feedback?: boolean }, api: PrepAPI): Promise<{ status: 'exists' | 'created'; groupId: string }> {
  const { account, appId, name, publicLink, feedback } = input;
  requireWrite(account, appId); needId(appId);
  if (!name || name.length > 50) throw new Error('Group name must be 1-50 characters.');
  const found = (await api.list(`/v1/apps/${appId}/betaGroups?limit=200`, 2000)).data.find(row => row.attributes.name === name);
  if (found) return { status: 'exists', groupId: found.id };
  const created = await api.post('/v1/betaGroups', { data: { type: 'betaGroups', attributes: { name, ...clean({ publicLinkEnabled: publicLink, feedbackEnabled: feedback }) }, relationships: { app: rel('apps', appId) } } });
  return { status: 'created', groupId: created.id };
}
async function ownedGroup(api: PrepAPI, appId: string, groupId: string): Promise<void> {
  needId(appId, groupId);
  if ((await api.get(`/v1/betaGroups/${groupId}/app`)).id !== appId) throw new Error('Beta group does not belong to this app.');
}
/** Adds testers to a group, creating each one if needed. Apple emails the invitation. */
export async function addBetaTesters(input: { account: Account; appId: string; groupId: string; testers: { email: string; firstName?: string; lastName?: string }[] }, api: PrepAPI): Promise<{ groupId: string; added: string[]; alreadyInGroup: string[] }> {
  const { account, appId, groupId, testers } = input;
  requireWrite(account, appId);
  await ownedGroup(api, appId, groupId);
  if (!testers.length || testers.length > 500) throw new Error('Provide 1-500 testers.');
  const added: string[] = []; const alreadyInGroup: string[] = [];
  const members = await api.list(`/v1/betaGroups/${groupId}/betaTesters?limit=200`, 2000);
  if (members.truncated) throw new Error('Incomplete tester list.');
  const known = new Set(members.data.map(row => String(row.attributes.email).toLowerCase()));
  for (const tester of testers) {
    const email = tester.email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Invalid tester email ${email}.`);
    if (known.has(email.toLowerCase())) { alreadyInGroup.push(email); continue; }
    const found = (await api.list(`/v1/betaTesters?${new URLSearchParams({ 'filter[email]': email, limit: '1' })}`, 1)).data[0];
    if (found) await api.request('POST', `/v1/betaGroups/${groupId}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: found.id }] });
    else await api.post('/v1/betaTesters', { data: { type: 'betaTesters', attributes: { email, ...clean({ firstName: tester.firstName, lastName: tester.lastName }) }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: groupId }] } } } });
    added.push(email);
  }
  return { groupId, added, alreadyInGroup };
}
export async function removeBetaTester(input: { account: Account; appId: string; groupId: string; testerId: string }, api: PrepAPI): Promise<{ removed: string }> {
  const { account, appId, groupId, testerId } = input;
  requireWrite(account, appId); needId(testerId);
  await ownedGroup(api, appId, groupId);
  await api.request('DELETE', `/v1/betaGroups/${groupId}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: testerId }] });
  return { removed: testerId };
}

// ---- After release ----
/** Publishes or replaces the developer response to a customer review. */
export async function replyToReview(input: { account: Account; appId: string; reviewId: string; text: string }, api: PrepAPI): Promise<{ responseId: string }> {
  const { account, appId, reviewId, text } = input;
  requireWrite(account, appId); needId(appId, reviewId);
  if (!text.trim() || [...text].length > 5970) throw new Error('Response must be 1-5970 characters.');
  const reviews = await api.list(`/v1/apps/${appId}/customerReviews?limit=200&sort=-createdDate`, 2000);
  if (!reviews.data.some(row => row.id === reviewId)) throw new Error('Review was not found among this app\'s latest reviews.');
  const created = await api.post('/v1/customerReviewResponses', { data: { type: 'customerReviewResponses', attributes: { responseBody: text }, relationships: { review: rel('customerReviews', reviewId) } } });
  return { responseId: created.id };
}
