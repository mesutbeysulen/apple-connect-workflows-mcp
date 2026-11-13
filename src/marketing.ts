import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import { validGroup, validId } from './apple-rules.js';
import { imageState, type AssetAPI } from './asset-library.js';
import { libraryAsset, linkedAsset, type CreativeKind } from './creative-assets.js';
import { submitForReview, type ReviewAPI, type ReviewRelation } from './review.js';

export interface MarketingAPI extends AssetAPI, Pick<ReviewAPI, 'patch'> {}
const rel = (type: string, id: string) => ({ data: { type, id } });
const clean = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const needIds = (...ids: string[]) => { if (!ids.every(validId)) throw new Error('Invalid ID.'); };
const chars = (value: string | undefined, max: number, label: string) => { if (value !== undefined && [...value].length > max) throw new Error(`${label} is limited to ${max} characters.`); };
const locale = (value: string) => { if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) throw new Error(`Invalid locale ${value}.`); };
const url = (value: string | undefined, label: string) => { if (value !== undefined && !(URL.canParse(value) && /^[a-z][a-z0-9+.-]*:/i.test(value))) throw new Error(`${label} must be a full URL or app deep link.`); };
async function all(api: Pick<AssetAPI, 'list'>, path: string): Promise<Resource[]> {
  const rows = await api.list(path, 2000);
  if (rows.truncated) throw new Error(`Incomplete list at ${path.split('?')[0]}; refusing to continue.`);
  return rows.data;
}
async function upsertLocale(api: MarketingAPI, rows: Resource[], wantedLocale: string, resource: string, fields: Record<string, unknown>, parent: Record<string, unknown>) {
  const existing = rows.find(row => row.attributes.locale === wantedLocale);
  const wanted = clean(fields);
  if (!existing) return { status: 'created' as const, id: (await api.post(`/v1/${resource}`, { data: { type: resource, attributes: { locale: wantedLocale, ...wanted }, relationships: parent } })).id };
  const changes = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => existing.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, id: existing.id };
  await api.patch(`/v1/${resource}/${existing.id}`, resource, existing.id, changes);
  return { status: 'updated' as const, id: existing.id, changed: Object.keys(changes) };
}

// ---- Custom Product Pages ----
const pages = (api: MarketingAPI, appId: string) => all(api, `/v1/apps/${appId}/appCustomProductPages?limit=200`);
async function ownedPage(api: MarketingAPI, appId: string, pageId: string): Promise<Resource> {
  needIds(appId, pageId);
  const page = (await pages(api, appId)).find(row => row.id === pageId);
  if (!page) throw new Error('Custom product page does not belong to this app.');
  return page;
}
/** Finds a page version and checks the page belongs to the app. */
async function ownedPageVersion(api: MarketingAPI, appId: string, versionId: string): Promise<{ page: Resource; version: Resource }> {
  needIds(appId, versionId);
  for (const page of await pages(api, appId)) {
    const version = (await all(api, `/v1/appCustomProductPages/${page.id}/appCustomProductPageVersions?limit=200`)).find(row => row.id === versionId);
    if (version) return { page, version };
  }
  throw new Error('Custom product page version does not belong to this app.');
}
/** Creates a Custom Product Page, or returns the one with the same name, plus its editable version. */
export async function createCustomPage(input: { account: Account; appId: string; name: string; deepLink?: string }, api: MarketingAPI) {
  const { account, appId, name, deepLink } = input;
  requireWrite(account, appId); needIds(appId);
  if (!name.trim() || [...name].length > 64) throw new Error('Page name must be 1-64 characters.');
  url(deepLink, 'Deep link');
  let page = (await pages(api, appId)).find(row => row.attributes.name === name);
  const status = page ? 'exists' as const : 'created' as const;
  page ??= await api.post('/v1/appCustomProductPages', { data: { type: 'appCustomProductPages', attributes: { name }, relationships: { app: rel('apps', appId) } } });
  const versions = await all(api, `/v1/appCustomProductPages/${page.id}/appCustomProductPageVersions?limit=200`);
  const editable = versions.find(row => ['PREPARE_FOR_SUBMISSION', 'REJECTED'].includes(String(row.attributes.state)));
  const version = editable ?? await api.post('/v1/appCustomProductPageVersions', { data: { type: 'appCustomProductPageVersions', ...(deepLink ? { attributes: { deepLink } } : {}), relationships: { appCustomProductPage: rel('appCustomProductPages', page.id) } } });
  if (editable && deepLink !== undefined && editable.attributes.deepLink !== deepLink) await api.patch(`/v1/appCustomProductPageVersions/${editable.id}`, 'appCustomProductPageVersions', editable.id, { deepLink });
  return { status, pageId: page.id, versionId: version.id, versionCreated: !editable };
}
export async function updateCustomPage(input: { account: Account; appId: string; pageId: string; name?: string; visible?: boolean }, api: MarketingAPI) {
  const { account, appId, pageId, name, visible } = input;
  requireWrite(account, appId);
  const page = await ownedPage(api, appId, pageId);
  if (name !== undefined && (!name.trim() || [...name].length > 64)) throw new Error('Page name must be 1-64 characters.');
  const changes = Object.fromEntries(Object.entries(clean({ name, visible })).filter(([key, value]) => page.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, pageId };
  await api.patch(`/v1/appCustomProductPages/${pageId}`, 'appCustomProductPages', pageId, changes);
  return { status: 'updated' as const, pageId, changed: Object.keys(changes) };
}
export async function deleteCustomPage(input: { account: Account; appId: string; pageId: string }, api: MarketingAPI) {
  const { account, appId, pageId } = input;
  requireWrite(account, appId);
  await ownedPage(api, appId, pageId);
  await api.delete(`/v1/appCustomProductPages/${pageId}`);
  return { removed: pageId };
}
export async function localizeCustomPage(input: { account: Account; appId: string; versionId: string; locale: string; promotionalText?: string }, api: MarketingAPI) {
  const { account, appId, versionId, promotionalText } = input;
  requireWrite(account, appId); locale(input.locale); chars(promotionalText, 170, 'Promotional text');
  await ownedPageVersion(api, appId, versionId);
  const rows = await all(api, `/v1/appCustomProductPageVersions/${versionId}/appCustomProductPageLocalizations?limit=200`);
  return upsertLocale(api, rows, input.locale, 'appCustomProductPageLocalizations', { promotionalText }, { appCustomProductPageVersion: rel('appCustomProductPageVersions', versionId) });
}

// ---- In-app events ----
export const EVENT_BADGES = ['LIVE_EVENT', 'PREMIERE', 'CHALLENGE', 'COMPETITION', 'NEW_SEASON', 'MAJOR_UPDATE', 'SPECIAL_EVENT'];
export const EVENT_PURPOSES = ['APPROPRIATE_FOR_ALL_USERS', 'ATTRACT_NEW_USERS', 'KEEP_ACTIVE_USERS_INFORMED', 'BRING_BACK_LAPSED_USERS'];
export interface EventFields { referenceName?: string; badge?: string; purpose?: string; priority?: string; primaryLocale?: string; deepLink?: string; purchaseRequirement?: string;
  territories?: string[]; publishStart?: string; eventStart?: string; eventEnd?: string }
/** Validates fields and builds Apple's territory schedule; times must be ISO 8601 with a time zone. */
function eventAttributes(fields: EventFields): Record<string, unknown> {
  if (fields.badge !== undefined && !EVENT_BADGES.includes(fields.badge)) throw new Error(`Badge must be one of ${EVENT_BADGES.join(', ')}.`);
  if (fields.purpose !== undefined && !EVENT_PURPOSES.includes(fields.purpose)) throw new Error(`Purpose must be one of ${EVENT_PURPOSES.join(', ')}.`);
  if (fields.priority !== undefined && !['HIGH', 'NORMAL'].includes(fields.priority)) throw new Error('Priority must be HIGH or NORMAL.');
  if (fields.primaryLocale !== undefined) locale(fields.primaryLocale);
  url(fields.deepLink, 'Deep link');
  chars(fields.referenceName, 64, 'Reference name');
  const times = [fields.publishStart, fields.eventStart, fields.eventEnd];
  let territorySchedules: unknown;
  if (fields.territories || times.some(Boolean)) {
    if (!fields.territories?.length || !times.every(t => t && /T.*(Z|[+-]\d{2}:?\d{2})$/.test(t) && Number.isFinite(Date.parse(t)))) throw new Error('A schedule needs --territories and --publish, --start and --end as ISO times with a time zone, e.g. 2027-01-10T09:00:00Z.');
    if (!fields.territories.every(t => /^[A-Z]{3}$/.test(t))) throw new Error('Territories must be three-letter codes such as USA.');
    const [publish, start, end] = times.map(t => Date.parse(t!)) as [number, number, number];
    if (!(publish <= start && start < end)) throw new Error('Times must satisfy publish <= start < end.');
    territorySchedules = [{ territories: fields.territories, publishStart: fields.publishStart, eventStart: fields.eventStart, eventEnd: fields.eventEnd }];
  }
  return clean({ referenceName: fields.referenceName, badge: fields.badge, purpose: fields.purpose, priority: fields.priority, primaryLocale: fields.primaryLocale,
    deepLink: fields.deepLink, purchaseRequirement: fields.purchaseRequirement, territorySchedules });
}
const events = (api: MarketingAPI, appId: string) => all(api, `/v1/apps/${appId}/appEvents?limit=200`);
async function ownedEvent(api: MarketingAPI, appId: string, eventId: string): Promise<Resource> {
  needIds(appId, eventId);
  const event = (await events(api, appId)).find(row => row.id === eventId);
  if (!event) throw new Error('In-app event does not belong to this app.');
  return event;
}
/** Creates an in-app event, or returns the one with the same reference name. */
export async function createEvent(input: { account: Account; appId: string } & EventFields & { referenceName: string }, api: MarketingAPI) {
  const { account, appId, ...fields } = input;
  requireWrite(account, appId); needIds(appId);
  if (!fields.referenceName.trim()) throw new Error('Reference name is required.');
  const attributes = eventAttributes(fields);
  const found = (await events(api, appId)).find(row => row.attributes.referenceName === fields.referenceName);
  if (found) return { status: 'exists' as const, eventId: found.id };
  return { status: 'created' as const, eventId: (await api.post('/v1/appEvents', { data: { type: 'appEvents', attributes, relationships: { app: rel('apps', appId) } } })).id };
}
export async function updateEvent(input: { account: Account; appId: string; eventId: string } & EventFields, api: MarketingAPI) {
  const { account, appId, eventId, ...fields } = input;
  requireWrite(account, appId);
  const attributes = eventAttributes(fields);
  if (!Object.keys(attributes).length) throw new Error('Provide a field to change.');
  const event = await ownedEvent(api, appId, eventId);
  const changes = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => JSON.stringify(event.attributes[key]) !== JSON.stringify(value)));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, eventId };
  await api.patch(`/v1/appEvents/${eventId}`, 'appEvents', eventId, changes);
  return { status: 'updated' as const, eventId, changed: Object.keys(changes) };
}
export async function deleteEvent(input: { account: Account; appId: string; eventId: string }, api: MarketingAPI) {
  const { account, appId, eventId } = input;
  requireWrite(account, appId);
  await ownedEvent(api, appId, eventId);
  await api.delete(`/v1/appEvents/${eventId}`);
  return { removed: eventId };
}
/** Event name 30, short description 50 and long description 120 characters, as App Store Connect enforces. */
export async function localizeEvent(input: { account: Account; appId: string; eventId: string; locale: string; name?: string; shortDescription?: string; longDescription?: string }, api: MarketingAPI) {
  const { account, appId, eventId, name, shortDescription, longDescription } = input;
  requireWrite(account, appId); locale(input.locale);
  chars(name, 30, 'Event name'); chars(shortDescription, 50, 'Short description'); chars(longDescription, 120, 'Long description');
  await ownedEvent(api, appId, eventId);
  const rows = await all(api, `/v1/appEvents/${eventId}/localizations?limit=200`);
  return upsertLocale(api, rows, input.locale, 'appEventLocalizations', { name, shortDescription, longDescription }, { appEvent: rel('appEvents', eventId) });
}

// ---- Product page A/B tests ----
const experiments = (api: MarketingAPI, appId: string) => all(api, `/v1/apps/${appId}/appStoreVersionExperimentsV2?limit=200`);
async function ownedExperiment(api: MarketingAPI, appId: string, experimentId: string): Promise<Resource> {
  needIds(appId, experimentId);
  const experiment = (await experiments(api, appId)).find(row => row.id === experimentId);
  if (!experiment) throw new Error('Experiment does not belong to this app.');
  return experiment;
}
async function ownedTreatment(api: MarketingAPI, appId: string, treatmentId: string): Promise<Resource> {
  needIds(appId, treatmentId);
  for (const experiment of await experiments(api, appId)) {
    const treatment = (await all(api, `/v2/appStoreVersionExperiments/${experiment.id}/appStoreVersionExperimentTreatments?limit=200`)).find(row => row.id === treatmentId);
    if (treatment) return treatment;
  }
  throw new Error('Treatment does not belong to this app.');
}
export async function createExperiment(input: { account: Account; appId: string; name: string; platform: string; trafficProportion: number }, api: MarketingAPI) {
  const { account, appId, name, platform, trafficProportion } = input;
  requireWrite(account, appId); needIds(appId);
  if (!name.trim() || [...name].length > 64) throw new Error('Experiment name must be 1-64 characters.');
  if (!['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'].includes(platform)) throw new Error('Platform must be IOS, MAC_OS, TV_OS or VISION_OS.');
  if (!Number.isInteger(trafficProportion) || trafficProportion < 1 || trafficProportion > 100) throw new Error('Traffic must be a whole percentage from 1 to 100.');
  const found = (await experiments(api, appId)).find(row => row.attributes.name === name);
  if (found) return { status: 'exists' as const, experimentId: found.id };
  return { status: 'created' as const, experimentId: (await api.post('/v2/appStoreVersionExperiments', { data: { type: 'appStoreVersionExperiments', attributes: { name, platform, trafficProportion }, relationships: { app: rel('apps', appId) } } })).id };
}
export async function createTreatment(input: { account: Account; appId: string; experimentId: string; name: string; appIconName?: string }, api: MarketingAPI) {
  const { account, appId, experimentId, name, appIconName } = input;
  requireWrite(account, appId);
  if (!name.trim() || [...name].length > 64) throw new Error('Treatment name must be 1-64 characters.');
  await ownedExperiment(api, appId, experimentId);
  const found = (await all(api, `/v2/appStoreVersionExperiments/${experimentId}/appStoreVersionExperimentTreatments?limit=200`)).find(row => row.attributes.name === name);
  if (found) return { status: 'exists' as const, treatmentId: found.id };
  return { status: 'created' as const, treatmentId: (await api.post('/v1/appStoreVersionExperimentTreatments', { data: { type: 'appStoreVersionExperimentTreatments', attributes: clean({ name, appIconName }),
    relationships: { appStoreVersionExperimentV2: rel('appStoreVersionExperiments', experimentId) } } })).id };
}
export async function localizeTreatment(input: { account: Account; appId: string; treatmentId: string; locale: string }, api: MarketingAPI) {
  const { account, appId, treatmentId } = input;
  requireWrite(account, appId); locale(input.locale);
  await ownedTreatment(api, appId, treatmentId);
  const rows = await all(api, `/v1/appStoreVersionExperimentTreatments/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations?limit=200`);
  return upsertLocale(api, rows, input.locale, 'appStoreVersionExperimentTreatmentLocalizations', {}, { appStoreVersionExperimentTreatment: rel('appStoreVersionExperimentTreatments', treatmentId) });
}
/** Starts or stops an approved experiment, or changes its traffic share. */
export async function updateExperiment(input: { account: Account; appId: string; experimentId: string; started?: boolean; trafficProportion?: number; name?: string }, api: MarketingAPI) {
  const { account, appId, experimentId, started, trafficProportion, name } = input;
  requireWrite(account, appId);
  if (trafficProportion !== undefined && (!Number.isInteger(trafficProportion) || trafficProportion < 1 || trafficProportion > 100)) throw new Error('Traffic must be a whole percentage from 1 to 100.');
  const experiment = await ownedExperiment(api, appId, experimentId);
  const changes = Object.fromEntries(Object.entries(clean({ started, trafficProportion, name })).filter(([key, value]) => experiment.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, experimentId };
  await api.patch(`/v2/appStoreVersionExperiments/${experimentId}`, 'appStoreVersionExperiments', experimentId, changes);
  return { status: 'updated' as const, experimentId, changed: Object.keys(changes), state: experiment.attributes.state };
}

// ---- Media on these pages, from the Asset Library ----
export type MarketingTarget = 'cpp' | 'experiment' | 'event';
const TARGET = {
  cpp: { relation: 'appCustomProductPageLocalization', type: 'appCustomProductPageLocalizations', types: ['APP_SCREENSHOT', 'IMESSAGE_APP_SCREENSHOT', 'APP_PREVIEW', 'PRODUCT_PAGE_HEADER_ASSET', 'APP_STORE_SEARCH_RESULTS_ASSET'] },
  experiment: { relation: 'appStoreVersionExperimentTreatmentLocalization', type: 'appStoreVersionExperimentTreatmentLocalizations', types: ['APP_SCREENSHOT', 'IMESSAGE_APP_SCREENSHOT', 'APP_PREVIEW', 'PRODUCT_PAGE_HEADER_ASSET', 'APP_STORE_SEARCH_RESULTS_ASSET'] },
  event: { relation: 'appEventLocalization', type: 'appEventLocalizations', types: ['EVENT_CARD_ASSET', 'EVENT_DETAILS_PAGE_ASSET'] },
} as const;
const GROUPED = new Set(['APP_SCREENSHOT', 'IMESSAGE_APP_SCREENSHOT', 'APP_PREVIEW']);
/** Proves a CPP, treatment or event localization belongs to the app by walking down from the app. */
async function ownedLocalization(api: MarketingAPI, appId: string, target: MarketingTarget, localizationId: string): Promise<void> {
  needIds(appId, localizationId);
  if (target === 'cpp') {
    for (const page of await pages(api, appId)) for (const version of await all(api, `/v1/appCustomProductPages/${page.id}/appCustomProductPageVersions?limit=200`)) {
      if ((await all(api, `/v1/appCustomProductPageVersions/${version.id}/appCustomProductPageLocalizations?limit=200`)).some(row => row.id === localizationId)) return;
    }
  } else if (target === 'experiment') {
    for (const experiment of await experiments(api, appId)) for (const treatment of await all(api, `/v2/appStoreVersionExperiments/${experiment.id}/appStoreVersionExperimentTreatments?limit=200`)) {
      if ((await all(api, `/v1/appStoreVersionExperimentTreatments/${treatment.id}/appStoreVersionExperimentTreatmentLocalizations?limit=200`)).some(row => row.id === localizationId)) return;
    }
  } else {
    for (const event of await events(api, appId)) if ((await all(api, `/v1/appEvents/${event.id}/localizations?limit=200`)).some(row => row.id === localizationId)) return;
  }
  throw new Error('Localization does not belong to this app.');
}
/** Places an Asset Library image or video on a Custom Product Page, experiment treatment or in-app event. Reruns find the existing placement. */
export async function placeMarketingAsset(input: { account: Account; appId: string; target: MarketingTarget; localizationId: string; kind: CreativeKind; assetId: string; placementType: string; placementGroup?: string }, api: MarketingAPI) {
  const { account, appId, target, localizationId, kind, assetId, placementType, placementGroup } = input;
  requireWrite(account, appId);
  const spec = TARGET[target];
  if (!spec) throw new Error('Target must be cpp, experiment or event.');
  if (!(spec.types as readonly string[]).includes(placementType)) throw new Error(`Placement type for ${target} must be one of ${spec.types.join(', ')}.`);
  if (GROUPED.has(placementType) && !placementGroup) throw new Error(`${placementType} needs --placement-group.`);
  if (placementGroup !== undefined && !validGroup(placementGroup)) throw new Error('Invalid placement group.');
  if (placementType === 'APP_PREVIEW' && kind !== 'video') throw new Error('App previews need a video.');
  if ((placementType === 'APP_SCREENSHOT' || placementType === 'IMESSAGE_APP_SCREENSHOT') && kind !== 'image') throw new Error(`${placementType} needs an image.`);
  await ownedLocalization(api, appId, target, localizationId);
  const state = imageState(await libraryAsset(api, appId, kind, assetId));
  if (['AWAITING_UPLOAD', 'FAILED', 'REJECTED', 'ARCHIVED'].includes(state)) throw new Error(`${kind} ${assetId} cannot be placed from state ${state}.`);
  const query = new URLSearchParams({ [`filter[${kind}]`]: assetId, 'filter[placementType]': placementType, limit: '50', include: 'image,video' });
  if (placementGroup) query.set('filter[placementGroup]', placementGroup);
  const existing = (await api.list(`/v1/${spec.type}/${localizationId}/placements?${query}`, 50)).data.find(row => linkedAsset(row)?.id === assetId);
  if (existing) return { status: 'exists' as const, placementId: existing.id };
  const created = await api.post('/v1/appAssetLibraryPlacements', { data: { type: 'appAssetLibraryPlacements', attributes: clean({ placementType, placementGroup }),
    relationships: { [kind]: rel(kind === 'image' ? 'appAssetLibraryImages' : 'appAssetLibraryVideos', assetId), [spec.relation]: rel(spec.type, localizationId) } } });
  return { status: 'created' as const, placementId: created.id };
}
/** Sets the display order inside one placement group of a CPP or treatment localization, then reads it back. */
export async function orderMarketingAssets(input: { account: Account; appId: string; target: 'cpp' | 'experiment'; localizationId: string; placementGroup: string; placementIds: string[] }, api: MarketingAPI) {
  const { account, appId, target, localizationId, placementGroup, placementIds } = input;
  requireWrite(account, appId);
  if (!validGroup(placementGroup)) throw new Error('Invalid placement group.');
  if (!placementIds.length || new Set(placementIds).size !== placementIds.length || !placementIds.every(validId)) throw new Error('Provide each placement ID once, in the desired order.');
  await ownedLocalization(api, appId, target, localizationId);
  const spec = TARGET[target];
  const read = async () => (await all(api, `/v1/${spec.type}/${localizationId}/placements?${new URLSearchParams({ 'filter[placementGroup]': placementGroup, sort: 'placementGroupPosition', limit: '200' })}`)).map(row => row.id);
  const current = await read();
  if (current.length !== placementIds.length || !placementIds.every(id => current.includes(id))) throw new Error(`Order must list every current placement once. Current order: ${current.join(',')}`);
  if (current.join() === placementIds.join()) return { status: 'unchanged' as const, order: current };
  await api.post('/v1/appAssetLibraryPlacementOrderingRequests', { data: { type: 'appAssetLibraryPlacementOrderingRequests', attributes: { placementGroup },
    relationships: { orderedPlacements: { data: placementIds.map(id => ({ type: 'appAssetLibraryPlacements', id })) }, [spec.relation]: rel(spec.type, localizationId) } } });
  const after = await read();
  if (after.join() !== placementIds.join()) throw new Error(`Apple has not confirmed the requested order. Current order: ${after.join(',')}`);
  return { status: 'reordered' as const, order: after };
}

// ---- Review ----
/** Sends a Custom Product Page version, experiment or in-app event to App Review after checking it belongs to the app. */
export async function submitMarketing(input: { account: Account; appId: string; kind: MarketingTarget; id: string }, api: MarketingAPI & ReviewAPI) {
  const { account, appId, kind, id } = input;
  requireWrite(account, appId);
  let relation: ReviewRelation;
  if (kind === 'cpp') { await ownedPageVersion(api, appId, id); relation = 'appCustomProductPageVersion'; }
  else if (kind === 'experiment') { await ownedExperiment(api, appId, id); relation = 'appStoreVersionExperimentV2'; }
  else if (kind === 'event') { await ownedEvent(api, appId, id); relation = 'appEvent'; }
  else throw new Error('Kind must be cpp, experiment or event.');
  return submitForReview({ account, appId, items: [{ relation, id }] }, api);
}
