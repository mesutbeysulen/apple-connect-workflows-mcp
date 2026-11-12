import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import { validId } from './apple-rules.js';

export interface CommercialAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
}
const validProductId = (id: string) => /^[A-Za-z0-9._-]{1,100}$/.test(id);
const validName = (name: string) => [...name].length >= 1 && [...name].length <= 64;
const rel = (type: string, id: string) => ({ data: { type, id } });
export const IAP_TYPES = ['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'];
export const SUBSCRIPTION_PERIODS = ['ONE_WEEK', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];
export interface Created { status: 'exists' | 'created'; id: string }
export type ProductKind = 'iap' | 'subscription' | 'subscription-group';
const PRODUCT_VERSION = {
  iap: { parent: 'inAppPurchases', path: '/v2/inAppPurchases', version: 'inAppPurchaseVersions', relation: 'inAppPurchase', localization: 'inAppPurchaseLocalizations' },
  subscription: { parent: 'subscriptions', path: '/v1/subscriptions', version: 'subscriptionVersions', relation: 'subscription', localization: 'subscriptionLocalizations' },
  'subscription-group': { parent: 'subscriptionGroups', path: '/v1/subscriptionGroups', version: 'subscriptionGroupVersions', relation: 'subscriptionGroup', localization: 'subscriptionGroupLocalizations' },
} as const;

async function appIaps(api: CommercialAPI, appId: string): Promise<Resource[]> {
  const rows = await api.list(`/v1/apps/${appId}/inAppPurchasesV2?limit=200`, 2000);
  if (rows.truncated) throw new Error('Incomplete in-app purchase list; refusing to continue.');
  return rows.data;
}
export async function appSubscription(api: CommercialAPI, appId: string, subscriptionId: string): Promise<Resource> {
  const groups = await api.list(`/v1/apps/${appId}/subscriptionGroups?limit=200`, 2000);
  if (groups.truncated) throw new Error('Incomplete subscription group list.');
  for (const group of groups.data) {
    const subs = await api.list(`/v1/subscriptionGroups/${group.id}/subscriptions?limit=200`, 2000);
    if (subs.truncated) throw new Error('Incomplete subscription list.');
    const match = subs.data.find(row => row.id === subscriptionId);
    if (match) return match;
  }
  throw new Error('Subscription does not belong to this app.');
}
async function ownedProduct(api: CommercialAPI, appId: string, kind: ProductKind, productId: string): Promise<void> {
  if (!validId(productId)) throw new Error('Invalid product ID.');
  if (kind === 'subscription') { await appSubscription(api, appId, productId); return; }
  const path = kind === 'iap' ? `/v1/apps/${appId}/inAppPurchasesV2?limit=200` : `/v1/apps/${appId}/subscriptionGroups?limit=200`;
  const rows = await api.list(path, 2000);
  if (rows.truncated) throw new Error('Incomplete product list.');
  if (!rows.data.some(row => row.id === productId)) throw new Error(`${kind} ${productId} does not belong to app ${appId}.`);
}
/** Creates a draft metadata version. Apple freezes version contents after submission. */
export async function createProductVersion(input: { account: Account; appId: string; kind: ProductKind; productId: string }, api: CommercialAPI): Promise<Created> {
  const { account, appId, kind, productId } = input;
  requireWrite(account, appId);
  const spec = PRODUCT_VERSION[kind];
  if (!spec) throw new Error('Invalid product kind.');
  await ownedProduct(api, appId, kind, productId);
  const versions = await api.list(`${spec.path}/${productId}/versions?limit=200`, 2000);
  if (versions.truncated) throw new Error('Incomplete product version list.');
  const draft = versions.data.find(row => row.attributes.state === 'PREPARE_FOR_SUBMISSION');
  if (draft) return { status: 'exists', id: draft.id };
  const created = await api.post(`/v1/${spec.version}`, { data: { type: spec.version, relationships: { [spec.relation]: rel(spec.parent, productId) } } });
  return { status: 'created', id: created.id };
}
export async function draftProductVersion(api: CommercialAPI, appId: string, kind: ProductKind, productId: string, versionId: string): Promise<Resource> {
  const spec = PRODUCT_VERSION[kind];
  if (!spec || !validId(versionId)) throw new Error('Invalid product kind or version ID.');
  await ownedProduct(api, appId, kind, productId);
  const versions = await api.list(`${spec.path}/${productId}/versions?limit=200`, 2000);
  if (versions.truncated) throw new Error('Incomplete product version list.');
  const version = versions.data.find(row => row.id === versionId);
  if (!version) throw new Error(`Version ${versionId} does not belong to ${kind} ${productId}.`);
  if (version.attributes.state !== 'PREPARE_FOR_SUBMISSION') throw new Error(`Version ${versionId} is not editable (${version.attributes.state}).`);
  return version;
}
/** Localizes a draft product version using Apple's version-based v2 metadata API. */
export async function localizeProductVersion(input: { account: Account; appId: string; kind: ProductKind; productId: string; versionId: string; locale: string; name: string; description?: string; customAppName?: string }, api: CommercialAPI): Promise<Created | { status: 'updated' | 'unchanged'; id: string }> {
  const { account, appId, kind, productId, versionId, locale, name, description, customAppName } = input;
  requireWrite(account, appId);
  const spec = PRODUCT_VERSION[kind];
  if (!spec || !validId(versionId) || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) || !validName(name)) throw new Error('Use valid kind, version ID, locale and name.');
  if (kind === 'subscription-group' ? description !== undefined : customAppName !== undefined) throw new Error('This field does not apply to the selected product kind.');
  await draftProductVersion(api, appId, kind, productId, versionId);
  const localizations = await api.list(`/v1/${spec.version}/${versionId}/localizations?limit=200`, 2000);
  if (localizations.truncated) throw new Error('Incomplete product localization list.');
  const found = localizations.data.find(row => row.attributes.locale === locale);
  const attributes = { name, ...(description === undefined ? {} : { description }), ...(customAppName === undefined ? {} : { customAppName }) };
  if (found) {
    if (Object.entries(attributes).every(([field, value]) => found.attributes[field] === value)) return { status: 'unchanged', id: found.id };
    await api.patch(`/v2/${spec.localization}/${found.id}`, spec.localization, found.id, attributes);
    return { status: 'updated', id: found.id };
  }
  const created = await api.post(`/v2/${spec.localization}`, { data: { type: spec.localization, attributes: { ...attributes, locale }, relationships: { version: rel(spec.version, versionId) } } });
  return { status: 'created', id: created.id };
}
export async function createIap(input: { account: Account; appId: string; productId: string; name: string; type: string; familySharable?: boolean }, api: CommercialAPI): Promise<Created> {
  const { account, appId, productId, name, type, familySharable } = input;
  requireWrite(account, appId);
  if (!validProductId(productId) || !validName(name) || !IAP_TYPES.includes(type)) throw new Error(`Use a valid product ID, a name up to 64 characters and a type of ${IAP_TYPES.join(', ')}.`);
  const found = (await appIaps(api, appId)).find(row => row.attributes.productId === productId);
  if (found) return { status: 'exists', id: found.id };
  const created = await api.post('/v2/inAppPurchases', { data: { type: 'inAppPurchases',
    attributes: { productId, name, inAppPurchaseType: type, ...(familySharable === undefined ? {} : { familySharable }) }, relationships: { app: rel('apps', appId) } } });
  return { status: 'created', id: created.id };
}
export async function createSubscriptionGroup(input: { account: Account; appId: string; referenceName: string }, api: CommercialAPI): Promise<Created> {
  const { account, appId, referenceName } = input;
  requireWrite(account, appId);
  if (!validName(referenceName)) throw new Error('Reference name must be 1-64 characters.');
  const groups = await api.list(`/v1/apps/${appId}/subscriptionGroups?limit=200`, 2000);
  if (groups.truncated) throw new Error('Incomplete subscription group list.');
  const found = groups.data.find(row => row.attributes.referenceName === referenceName);
  if (found) return { status: 'exists', id: found.id };
  const created = await api.post('/v1/subscriptionGroups', { data: { type: 'subscriptionGroups', attributes: { referenceName }, relationships: { app: rel('apps', appId) } } });
  return { status: 'created', id: created.id };
}
export async function createSubscription(input: { account: Account; appId: string; groupId: string; productId: string; name: string; period: string; groupLevel?: number }, api: CommercialAPI): Promise<Created> {
  const { account, appId, groupId, productId, name, period, groupLevel } = input;
  requireWrite(account, appId);
  if (!validId(groupId) || !validProductId(productId) || !validName(name) || !SUBSCRIPTION_PERIODS.includes(period) || (groupLevel !== undefined && (!Number.isInteger(groupLevel) || groupLevel < 1))) throw new Error(`Use valid IDs, a name up to 64 characters and a period of ${SUBSCRIPTION_PERIODS.join(', ')}; group level must be a positive integer.`);
  const groups = await api.list(`/v1/apps/${appId}/subscriptionGroups?limit=200`, 2000);
  if (!groups.data.some(row => row.id === groupId)) throw new Error('Subscription group does not belong to this app.');
  const subs = await api.list(`/v1/subscriptionGroups/${groupId}/subscriptions?limit=200`, 2000);
  if (subs.truncated) throw new Error('Incomplete subscription list.');
  const found = subs.data.find(row => row.attributes.productId === productId);
  if (found) return { status: 'exists', id: found.id };
  const created = await api.post('/v1/subscriptions', { data: { type: 'subscriptions',
    attributes: { productId, name, subscriptionPeriod: period, ...(groupLevel === undefined ? {} : { groupLevel }) }, relationships: { group: rel('subscriptionGroups', groupId) } } });
  return { status: 'created', id: created.id };
}
/** Creates or updates one product localization. */
export async function localizeProduct(input: { account: Account; appId: string; kind: 'iap' | 'subscription'; productId: string; locale: string; name: string; description?: string }, api: CommercialAPI): Promise<Created | { status: 'updated' | 'unchanged'; id: string }> {
  const { account, appId, kind, productId, locale, name, description } = input;
  requireWrite(account, appId);
  if (!validId(productId) || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) || !name) throw new Error('Use a valid product ID, locale and name.');
  if (kind === 'iap') { if (!(await appIaps(api, appId)).some(row => row.id === productId)) throw new Error('In-app purchase does not belong to this app.'); }
  else await appSubscription(api, appId, productId);
  const listing = kind === 'iap' ? `/v2/inAppPurchases/${productId}/inAppPurchaseLocalizations?limit=200` : `/v1/subscriptions/${productId}/subscriptionLocalizations?limit=200`;
  const resource = kind === 'iap' ? 'inAppPurchaseLocalizations' : 'subscriptionLocalizations';
  const prefix = kind === 'iap' ? '/v2' : '/v1';
  const found = (await api.list(listing, 200)).data.find(row => row.attributes.locale === locale);
  if (found) {
    if (found.attributes.name === name && (description === undefined || found.attributes.description === description)) return { status: 'unchanged', id: found.id };
    await api.patch(`${prefix}/${resource}/${found.id}`, resource, found.id, { name, ...(description === undefined ? {} : { description }) });
    return { status: 'updated', id: found.id };
  }
  const relationships = kind === 'iap' ? { inAppPurchaseV2: rel('inAppPurchases', productId) } : { subscription: rel('subscriptions', productId) };
  const created = await api.post(`${prefix}/${resource}`, { data: { type: resource, attributes: { name, locale, ...(description === undefined ? {} : { description }) }, relationships } });
  return { status: 'created', id: created.id };
}
export interface CurrentPrice { id: string; manual?: unknown; startDate: unknown; endDate: unknown; territory?: string; pricePointId?: string }
export interface PricePreview { dryRun: boolean; target: string; territory: string; price: string; pricePointId: string; startDate: string | null; effect: string; current: CurrentPrice[]; currentIncomplete: boolean; result?: string; status?: 'created' | 'exists' }
const linkedId = (row: Resource, relation: string) => { const data = row.relationships?.[relation]?.data; return data && !Array.isArray(data) ? data.id : undefined; };
const toPrice = (row: Resource, pointRelation: string): CurrentPrice => ({ id: row.id, manual: row.attributes.manual, startDate: row.attributes.startDate ?? null, endDate: row.attributes.endDate ?? null, territory: linkedId(row, 'territory'), pricePointId: linkedId(row, pointRelation) });
/** Reads the manual prices a new schedule would replace, so the preview and output keep a record of them. */
async function currentSchedule(api: CommercialAPI, schedulePath: string, resource: string, pointRelation: string): Promise<{ current: CurrentPrice[]; currentIncomplete: boolean }> {
  let schedule: Resource | null;
  try { schedule = await api.get(schedulePath); }
  catch (error) { if (error instanceof AppleError && error.status === 404) return { current: [], currentIncomplete: false }; throw error; }
  if (!schedule) return { current: [], currentIncomplete: false };
  const rows = await api.list(`/v1/${resource}/${schedule.id}/manualPrices?${new URLSearchParams({ include: `${pointRelation},territory`, limit: '200' })}`, 2000);
  return { current: rows.data.map(row => toPrice(row, pointRelation)), currentIncomplete: rows.truncated };
}
/** Matches a decimal price exactly; Apple only sells fixed price points, so nothing is rounded silently. */
export async function pricePoint(api: CommercialAPI, path: string, territory: string, price: string): Promise<string> {
  if (!/^[A-Z]{3}$/.test(territory) || !/^\d+(\.\d{1,4})?$/.test(price)) throw new Error('Use a three-letter territory such as USA and a decimal price such as 4.99.');
  const query = new URLSearchParams({ 'filter[territory]': territory, limit: '200' });
  const points = await api.list(`${path}?${query}`, 2000);
  const point = points.data.find(row => Number(row.attributes.customerPrice) === Number(price));
  if (point) return point.id;
  const near = points.data.map(row => Number(row.attributes.customerPrice)).sort((a, b) => Math.abs(a - Number(price)) - Math.abs(b - Number(price))).slice(0, 5);
  throw new Error(`No ${territory} price point equals ${price}. Closest: ${near.join(', ')}.`);
}
const validDate = (date: string | undefined) => date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(date);
/** Previews unless execute is set. Posting a schedule replaces the app's whole manual schedule. */
export async function setAppPrice(input: { account: Account; appId: string; territory: string; price: string; startDate?: string; execute?: boolean }, api: CommercialAPI): Promise<PricePreview> {
  const { account, appId, territory, price, startDate, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validDate(startDate)) throw new Error('Start date must be YYYY-MM-DD.');
  const id = await pricePoint(api, `/v1/apps/${appId}/appPricePoints`, territory, price);
  const preview: PricePreview = { dryRun: !execute, target: `app ${appId}`, territory, price, pricePointId: id, startDate: startDate ?? null, effect: 'Replaces the full manual price schedule listed under current; other territories follow Apple equalization.', ...await currentSchedule(api, `/v1/apps/${appId}/appPriceSchedule`, 'appPriceSchedules', 'appPricePoint') };
  if (!execute) return preview;
  const created = await api.post('/v1/appPriceSchedules', { data: { type: 'appPriceSchedules', relationships: { app: rel('apps', appId), baseTerritory: rel('territories', territory), manualPrices: { data: [{ type: 'appPrices', id: '${price}' }] } } },
    included: [{ type: 'appPrices', id: '${price}', attributes: { startDate: startDate ?? null, endDate: null }, relationships: { appPricePoint: rel('appPricePoints', id) } }, { type: 'territories', id: territory }] });
  return { ...preview, result: created.id, status: 'created' };
}
export async function setIapPrice(input: { account: Account; appId: string; iapId: string; territory: string; price: string; startDate?: string; execute?: boolean }, api: CommercialAPI): Promise<PricePreview> {
  const { account, appId, iapId, territory, price, startDate, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validId(iapId) || !validDate(startDate)) throw new Error('Use a valid in-app purchase ID and YYYY-MM-DD start date.');
  if (!(await appIaps(api, appId)).some(row => row.id === iapId)) throw new Error('In-app purchase does not belong to this app.');
  const id = await pricePoint(api, `/v2/inAppPurchases/${iapId}/pricePoints`, territory, price);
  const preview: PricePreview = { dryRun: !execute, target: `iap ${iapId}`, territory, price, pricePointId: id, startDate: startDate ?? null, effect: 'Replaces the full manual price schedule listed under current.', ...await currentSchedule(api, `/v2/inAppPurchases/${iapId}/iapPriceSchedule`, 'inAppPurchasePriceSchedules', 'inAppPurchasePricePoint') };
  if (!execute) return preview;
  const created = await api.post('/v1/inAppPurchasePriceSchedules', { data: { type: 'inAppPurchasePriceSchedules', relationships: { inAppPurchase: rel('inAppPurchases', iapId), baseTerritory: rel('territories', territory), manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${price}' }] } } },
    included: [{ type: 'inAppPurchasePrices', id: '${price}', attributes: { startDate: startDate ?? null, endDate: null }, relationships: { inAppPurchaseV2: rel('inAppPurchases', iapId), inAppPurchasePricePoint: rel('inAppPurchasePricePoints', id) } }, { type: 'territories', id: territory }] });
  return { ...preview, result: created.id, status: 'created' };
}
export async function setSubscriptionPrice(input: { account: Account; appId: string; subscriptionId: string; territory: string; price: string; startDate?: string; preserveCurrentPrice?: boolean; execute?: boolean }, api: CommercialAPI): Promise<PricePreview> {
  const { account, appId, subscriptionId, territory, price, startDate, preserveCurrentPrice = false, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validId(subscriptionId) || !validDate(startDate)) throw new Error('Use a valid subscription ID and YYYY-MM-DD start date.');
  await appSubscription(api, appId, subscriptionId);
  const id = await pricePoint(api, `/v1/subscriptions/${subscriptionId}/pricePoints`, territory, price);
  const existing = await api.list(`/v1/subscriptions/${subscriptionId}/prices?${new URLSearchParams({ 'filter[territory]': territory, include: 'territory,subscriptionPricePoint', limit: '200' })}`, 2000);
  const current = existing.data.map(row => toPrice(row, 'subscriptionPricePoint'));
  const preview: PricePreview = { dryRun: !execute, target: `subscription ${subscriptionId}`, territory, price, pricePointId: id, startDate: startDate ?? null, current, currentIncomplete: existing.truncated,
    effect: preserveCurrentPrice ? 'New subscribers pay this price; existing subscribers keep their current price.' : 'Applies to this territory. Price increases for existing subscribers may require their consent.' };
  if (!execute) return preview;
  if (existing.truncated) throw new Error('Incomplete subscription price list; refusing a possibly duplicate price change.');
  // A retry after a lost response must not schedule the same change twice.
  const same = current.find(row => row.pricePointId === id && row.startDate === (startDate ?? null));
  if (same) return { ...preview, result: same.id, status: 'exists' };
  const created = await api.post('/v1/subscriptionPrices', { data: { type: 'subscriptionPrices', attributes: { startDate: startDate ?? null, preserveCurrentPrice },
    relationships: { subscription: rel('subscriptions', subscriptionId), territory: rel('territories', territory), subscriptionPricePoint: rel('subscriptionPricePoints', id) } } });
  return { ...preview, result: created.id, status: 'created' };
}
