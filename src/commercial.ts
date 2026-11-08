import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';

export interface CommercialAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
}
const validId = (id: string) => /^[A-Za-z0-9-]{1,128}$/.test(id);
const validProductId = (id: string) => /^[A-Za-z0-9._-]{1,100}$/.test(id);
const validName = (name: string) => [...name].length >= 1 && [...name].length <= 64;
const rel = (type: string, id: string) => ({ data: { type, id } });
export const IAP_TYPES = ['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'];
export const SUBSCRIPTION_PERIODS = ['ONE_WEEK', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];
export interface Created { status: 'exists' | 'created'; id: string }

async function appIaps(api: CommercialAPI, appId: string): Promise<Resource[]> {
  const rows = await api.list(`/v1/apps/${appId}/inAppPurchasesV2?limit=200`, 2000);
  if (rows.truncated) throw new Error('Incomplete in-app purchase list; refusing to continue.');
  return rows.data;
}
async function appSubscription(api: CommercialAPI, appId: string, subscriptionId: string): Promise<Resource> {
  const groups = await api.list(`/v1/apps/${appId}/subscriptionGroups?limit=200`, 2000);
  for (const group of groups.data) {
    const subs = await api.list(`/v1/subscriptionGroups/${group.id}/subscriptions?limit=200`, 2000);
    const match = subs.data.find(row => row.id === subscriptionId);
    if (match) return match;
  }
  throw new Error('Subscription does not belong to this app.');
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
  if (!validId(groupId) || !validProductId(productId) || !validName(name) || !SUBSCRIPTION_PERIODS.includes(period)) throw new Error(`Use valid IDs, a name up to 64 characters and a period of ${SUBSCRIPTION_PERIODS.join(', ')}.`);
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
export interface PricePreview { dryRun: boolean; target: string; territory: string; price: string; pricePointId: string; startDate: string | null; effect: string; result?: string }
/** Matches a decimal price exactly; Apple only sells fixed price points, so nothing is rounded silently. */
async function pricePoint(api: CommercialAPI, path: string, territory: string, price: string): Promise<string> {
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
  const preview: PricePreview = { dryRun: !execute, target: `app ${appId}`, territory, price, pricePointId: id, startDate: startDate ?? null, effect: 'Replaces the full manual price schedule; other territories follow Apple equalization.' };
  if (!execute) return preview;
  const created = await api.post('/v1/appPriceSchedules', { data: { type: 'appPriceSchedules', relationships: { app: rel('apps', appId), baseTerritory: rel('territories', territory), manualPrices: { data: [{ type: 'appPrices', id: '${price}' }] } } },
    included: [{ type: 'appPrices', id: '${price}', attributes: { startDate: startDate ?? null, endDate: null }, relationships: { appPricePoint: rel('appPricePoints', id) } }, { type: 'territories', id: territory }] });
  return { ...preview, result: created.id };
}
export async function setIapPrice(input: { account: Account; appId: string; iapId: string; territory: string; price: string; startDate?: string; execute?: boolean }, api: CommercialAPI): Promise<PricePreview> {
  const { account, appId, iapId, territory, price, startDate, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validId(iapId) || !validDate(startDate)) throw new Error('Use a valid in-app purchase ID and YYYY-MM-DD start date.');
  if (!(await appIaps(api, appId)).some(row => row.id === iapId)) throw new Error('In-app purchase does not belong to this app.');
  const id = await pricePoint(api, `/v2/inAppPurchases/${iapId}/pricePoints`, territory, price);
  const preview: PricePreview = { dryRun: !execute, target: `iap ${iapId}`, territory, price, pricePointId: id, startDate: startDate ?? null, effect: 'Replaces the full price schedule of this in-app purchase.' };
  if (!execute) return preview;
  const created = await api.post('/v1/inAppPurchasePriceSchedules', { data: { type: 'inAppPurchasePriceSchedules', relationships: { inAppPurchase: rel('inAppPurchases', iapId), baseTerritory: rel('territories', territory), manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${price}' }] } } },
    included: [{ type: 'inAppPurchasePrices', id: '${price}', attributes: { startDate: startDate ?? null, endDate: null }, relationships: { inAppPurchaseV2: rel('inAppPurchases', iapId), inAppPurchasePricePoint: rel('inAppPurchasePricePoints', id) } }, { type: 'territories', id: territory }] });
  return { ...preview, result: created.id };
}
export async function setSubscriptionPrice(input: { account: Account; appId: string; subscriptionId: string; territory: string; price: string; startDate?: string; preserveCurrentPrice?: boolean; execute?: boolean }, api: CommercialAPI): Promise<PricePreview> {
  const { account, appId, subscriptionId, territory, price, startDate, preserveCurrentPrice = false, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validId(subscriptionId) || !validDate(startDate)) throw new Error('Use a valid subscription ID and YYYY-MM-DD start date.');
  await appSubscription(api, appId, subscriptionId);
  const id = await pricePoint(api, `/v1/subscriptions/${subscriptionId}/pricePoints`, territory, price);
  const preview: PricePreview = { dryRun: !execute, target: `subscription ${subscriptionId}`, territory, price, pricePointId: id, startDate: startDate ?? null,
    effect: preserveCurrentPrice ? 'New subscribers pay this price; existing subscribers keep their current price.' : 'Applies to this territory. Price increases for existing subscribers may require their consent.' };
  if (!execute) return preview;
  const created = await api.post('/v1/subscriptionPrices', { data: { type: 'subscriptionPrices', attributes: { startDate: startDate ?? null, preserveCurrentPrice },
    relationships: { subscription: rel('subscriptions', subscriptionId), territory: rel('territories', territory), subscriptionPricePoint: rel('subscriptionPricePoints', id) } } });
  return { ...preview, result: created.id };
}
