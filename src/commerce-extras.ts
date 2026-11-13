import { createHash } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAccountWrite, requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import { validId } from './apple-rules.js';
import { appIaps, appSubscription, pricePoint, type CommercialAPI } from './commercial.js';
import { OFFER_DURATIONS, OFFER_MODES } from './offers.js';
import { readImage } from './screenshots.js';
import { putFilePart, validateOperations } from './upload-transfer.js';

export type ProductKind = 'iap' | 'subscription';
export interface ExtrasAPI extends CommercialAPI {
  delete(path: string): Promise<void>;
  download?(path: string, accept: string): Promise<Buffer>;
}
const rel = (type: string, id: string) => ({ data: { type, id } });
const linkedId = (row: Resource, relation: string) => { const data = row.relationships?.[relation]?.data; return data && !Array.isArray(data) ? data.id : undefined; };
const isDate = (value: string | undefined) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value);
async function optional(api: Pick<CommercialAPI, 'get'>, path: string): Promise<Resource | undefined> {
  try { return (await api.get(path)) ?? undefined; }
  catch (error) { if (error instanceof AppleError && error.status === 404) return undefined; throw error; }
}
/** Confirms the product belongs to the app before anything about it is read or changed. */
async function ownedProduct(api: CommercialAPI, appId: string, kind: ProductKind, productId: string): Promise<void> {
  if (!validId(productId)) throw new Error('Invalid product ID.');
  if (kind === 'iap') { if (!(await appIaps(api, appId)).some(row => row.id === productId)) throw new Error('In-app purchase does not belong to this app.'); }
  else if (kind === 'subscription') await appSubscription(api, appId, productId);
  else throw new Error('Kind must be iap or subscription.');
}
const PRODUCT = {
  iap: { parent: 'inAppPurchases', parentRelation: 'inAppPurchase', base: '/v2/inAppPurchases', pricePoints: (id: string) => `/v2/inAppPurchases/${id}/pricePoints` },
  subscription: { parent: 'subscriptions', parentRelation: 'subscription', base: '/v1/subscriptions', pricePoints: (id: string) => `/v1/subscriptions/${id}/pricePoints` },
} as const;

/** Parses "USA=0.99,TUR=29.99" into territory prices, refusing duplicates. */
export function parsePrices(value: string | undefined): { territory: string; price: string }[] {
  if (!value) return [];
  const prices = value.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const [territory, price] = part.split('=');
    if (!territory || !price || !/^[A-Z]{3}$/.test(territory) || !/^\d+(\.\d{1,4})?$/.test(price)) throw new Error(`Invalid price "${part}". Use TERRITORY=PRICE, e.g. USA=0.99.`);
    return { territory, price };
  });
  if (new Set(prices.map(p => p.territory)).size !== prices.length) throw new Error('Each territory may appear once in --prices.');
  return prices;
}
async function resolvePrices(api: CommercialAPI, kind: ProductKind, productId: string, prices: { territory: string; price: string }[]) {
  const resolved = [];
  for (const { territory, price } of prices) resolved.push({ territory, price, pricePointId: await pricePoint(api, PRODUCT[kind].pricePoints(productId), territory, price) });
  return resolved;
}
async function allTerritories(api: CommercialAPI): Promise<string[]> {
  const rows = await api.list('/v1/territories?limit=200', 2000);
  if (rows.truncated) throw new Error('Incomplete territory list.');
  return rows.data.map(row => row.id);
}

// ---- Where a product is sold ----
/**
 * Sets the territories where an in-app purchase or subscription is sold. Without this a product cannot be bought.
 * Previews the difference first; execute replaces the whole list.
 */
export async function setProductAvailability(input: { account: Account; appId: string; kind: ProductKind; productId: string; territories: string[] | 'all'; availableInNewTerritories: boolean; execute?: boolean }, api: ExtrasAPI) {
  const { account, appId, kind, productId, availableInNewTerritories, execute = false } = input;
  if (execute) requireWrite(account, appId);
  await ownedProduct(api, appId, kind, productId);
  const known = await allTerritories(api);
  const wanted = input.territories === 'all' ? known : [...new Set(input.territories)];
  const unknown = wanted.filter(t => !known.includes(t));
  if (!wanted.length || unknown.length) throw new Error(unknown.length ? `Unknown territories: ${unknown.join(', ')}.` : 'Provide --territories or --all.');
  const availabilityPath = kind === 'iap' ? `/v2/inAppPurchases/${productId}/inAppPurchaseAvailability` : `/v1/subscriptions/${productId}/subscriptionAvailability`;
  const resource = kind === 'iap' ? 'inAppPurchaseAvailabilities' : 'subscriptionAvailabilities';
  const current = await optional(api, availabilityPath);
  const currentTerritories = current ? (await api.list(`/v1/${resource}/${current.id}/availableTerritories?limit=200`, 2000)).data.map(row => row.id) : [];
  const preview = { dryRun: !execute, kind, productId, territories: wanted.length, added: wanted.filter(t => !currentTerritories.includes(t)), removed: currentTerritories.filter(t => !wanted.includes(t)),
    availableInNewTerritories, effect: 'Replaces the full list of territories where this product is sold.' };
  if (!execute) return preview;
  if (current && !preview.added.length && !preview.removed.length && current.attributes.availableInNewTerritories === availableInNewTerritories) return { ...preview, status: 'unchanged' as const };
  const created = await api.post(`/v1/${resource}`, { data: { type: resource, attributes: { availableInNewTerritories },
    relationships: { [PRODUCT[kind].parentRelation]: rel(PRODUCT[kind].parent, productId), availableTerritories: { data: wanted.map(id => ({ type: 'territories', id })) } } } });
  return { ...preview, status: 'updated' as const, availabilityId: created.id };
}

// ---- Sandbox testers (account level) ----
const RENEWAL_RATES = ['MONTHLY_RENEWAL_EVERY_ONE_HOUR', 'MONTHLY_RENEWAL_EVERY_THIRTY_MINUTES', 'MONTHLY_RENEWAL_EVERY_FIFTEEN_MINUTES', 'MONTHLY_RENEWAL_EVERY_FIVE_MINUTES', 'MONTHLY_RENEWAL_EVERY_THREE_MINUTES'];
async function knownTester(api: ExtrasAPI, testerId: string): Promise<Resource> {
  if (!validId(testerId)) throw new Error('Invalid sandbox tester ID.');
  const rows = await api.list('/v2/sandboxTesters?limit=200', 2000);
  const tester = rows.data.find(row => row.id === testerId);
  if (!tester) throw new Error('Sandbox tester not found on this team.');
  return tester;
}
/** Changes a sandbox tester's storefront, purchase interruption or subscription renewal speed. */
export async function updateSandboxTester(input: { account: Account; testerId: string; territory?: string; interruptPurchases?: boolean; renewalRate?: string }, api: ExtrasAPI) {
  const { account, testerId, territory, interruptPurchases, renewalRate } = input;
  requireAccountWrite(account);
  if (territory !== undefined && !/^[A-Z]{3}$/.test(territory)) throw new Error('Territory must be three letters such as USA.');
  if (renewalRate !== undefined && !RENEWAL_RATES.includes(renewalRate)) throw new Error(`Renewal rate must be one of ${RENEWAL_RATES.join(', ')}.`);
  const fields = Object.fromEntries(Object.entries({ territory, interruptPurchases, subscriptionRenewalRate: renewalRate }).filter(([, v]) => v !== undefined));
  if (!Object.keys(fields).length) throw new Error('Provide --territory, --interrupt-purchases or --renewal-rate.');
  const tester = await knownTester(api, testerId);
  const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => tester.attributes[key] !== value));
  if (!Object.keys(changes).length) return { testerId, status: 'unchanged' as const, changed: [] as string[] };
  await api.patch(`/v2/sandboxTesters/${testerId}`, 'sandboxTesters', testerId, changes);
  return { testerId, status: 'updated' as const, changed: Object.keys(changes) };
}
/** Clears purchase history so the same sandbox account can buy again. Cannot be undone. */
export async function clearSandboxHistory(input: { account: Account; testerIds: string[] }, api: ExtrasAPI): Promise<{ cleared: string[]; requestId: string }> {
  const { account } = input;
  requireAccountWrite(account);
  const testerIds = [...new Set(input.testerIds)];
  if (!testerIds.length || testerIds.length > 100) throw new Error('Provide 1-100 sandbox tester IDs.');
  for (const id of testerIds) await knownTester(api, id);
  const created = await api.post('/v2/sandboxTestersClearPurchaseHistoryRequest', { data: { type: 'sandboxTestersClearPurchaseHistoryRequest',
    relationships: { sandboxTesters: { data: testerIds.map(id => ({ type: 'sandboxTesters', id })) } } } });
  return { cleared: testerIds, requestId: created.id };
}

// ---- Promotional offers (for existing or lapsed subscribers, redeemed in the app) ----
export interface SubscriptionOfferTerms { offerMode: string; duration: string; numberOfPeriods: number; prices: { territory: string; price: string }[] }
function checkTerms(terms: SubscriptionOfferTerms): void {
  if (!OFFER_MODES.includes(terms.offerMode)) throw new Error(`Offer mode must be one of ${OFFER_MODES.join(', ')}.`);
  if (!OFFER_DURATIONS.includes(terms.duration)) throw new Error(`Duration must be one of ${OFFER_DURATIONS.join(', ')}.`);
  if (!Number.isInteger(terms.numberOfPeriods) || terms.numberOfPeriods < 1 || terms.numberOfPeriods > 12) throw new Error('Number of periods must be a whole number from 1 to 12.');
  // Paid modes need a price per territory; a free trial carries none, so a forgotten price never turns into a free offer.
  if ((terms.offerMode === 'FREE_TRIAL') !== !terms.prices.length) throw new Error(terms.offerMode === 'FREE_TRIAL' ? 'A free trial takes no --prices.' : 'Paid offers need --prices, e.g. USA=0.99,TUR=29.99.');
}
const inlinePrices = (type: string, pointType: string, pointRelation: string, prices: { territory: string; pricePointId: string }[]) => prices.map((p, i) => ({
  type, id: `\${price${i}}`, relationships: { territory: rel('territories', p.territory), [pointRelation]: rel(pointType, p.pricePointId) } }));

export async function createPromotionalOffer(input: { account: Account; appId: string; subscriptionId: string; name: string; offerCode: string; execute?: boolean } & SubscriptionOfferTerms, api: ExtrasAPI) {
  const { account, appId, subscriptionId, name, offerCode, execute = false, ...terms } = input;
  if (execute) requireWrite(account, appId);
  checkTerms(terms);
  if (!name || [...name].length > 64) throw new Error('Name must be 1-64 characters.');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(offerCode)) throw new Error('Offer code identifier may use letters, digits, dot, dash and underscore (1-64).');
  await ownedProduct(api, appId, 'subscription', subscriptionId);
  const prices = await resolvePrices(api, 'subscription', subscriptionId, terms.prices);
  const existing = (await api.list(`/v1/subscriptions/${subscriptionId}/promotionalOffers?limit=200`, 2000)).data.find(row => row.attributes.offerCode === offerCode);
  const preview = { dryRun: !execute, subscriptionId, name, offerCode, offerMode: terms.offerMode, duration: terms.duration, numberOfPeriods: terms.numberOfPeriods, prices };
  if (existing) return { ...preview, status: 'exists' as const, offerId: existing.id };
  if (!execute) return preview;
  const created = await api.post('/v1/subscriptionPromotionalOffers', { data: { type: 'subscriptionPromotionalOffers',
    attributes: { name, offerCode, offerMode: terms.offerMode, duration: terms.duration, numberOfPeriods: terms.numberOfPeriods },
    relationships: { subscription: rel('subscriptions', subscriptionId), prices: { data: prices.map((_, i) => ({ type: 'subscriptionPromotionalOfferPrices', id: `\${price${i}}` })) } } },
    included: inlinePrices('subscriptionPromotionalOfferPrices', 'subscriptionPricePoints', 'subscriptionPricePoint', prices) });
  return { ...preview, status: 'created' as const, offerId: created.id };
}
export async function deletePromotionalOffer(input: { account: Account; appId: string; subscriptionId: string; offerId: string }, api: ExtrasAPI): Promise<{ removed: string }> {
  const { account, appId, subscriptionId, offerId } = input;
  requireWrite(account, appId);
  await ownedProduct(api, appId, 'subscription', subscriptionId);
  if (!(await api.list(`/v1/subscriptions/${subscriptionId}/promotionalOffers?limit=200`, 2000)).data.some(row => row.id === offerId)) throw new Error('Offer does not belong to this subscription.');
  await api.delete(`/v1/subscriptionPromotionalOffers/${offerId}`);
  return { removed: offerId };
}

// ---- Offer codes (redeemed through App Store links or codes) ----
const SUB_ELIGIBILITY = ['NEW', 'EXISTING', 'EXPIRED'];
const IAP_ELIGIBILITY = ['NON_SPENDER', 'ACTIVE_SPENDER', 'CHURNED_SPENDER'];
const OFFER_ELIGIBILITY = ['STACK_WITH_INTRO_OFFERS', 'REPLACE_INTRO_OFFERS'];
const CODE_RESOURCE = { iap: 'inAppPurchaseOfferCodes', subscription: 'subscriptionOfferCodes' } as const;
export interface OfferCodeInput {
  account: Account; appId: string; kind: ProductKind; productId: string; name: string; eligibility: string[];
  prices: { territory: string; price: string }[]; offerEligibility?: string; offerMode?: string; duration?: string; numberOfPeriods?: number; execute?: boolean;
}
/** Creates an offer code campaign. Codes themselves are generated separately with offer-codes-generate. */
export async function createOfferCode(input: OfferCodeInput, api: ExtrasAPI) {
  const { account, appId, kind, productId, name, eligibility, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!name || [...name].length > 64) throw new Error('Name must be 1-64 characters.');
  const allowed = kind === 'iap' ? IAP_ELIGIBILITY : SUB_ELIGIBILITY;
  if (!eligibility.length || !eligibility.every(e => allowed.includes(e))) throw new Error(`Eligibility must use ${allowed.join(', ')}.`);
  if (kind === 'subscription') {
    checkTerms({ offerMode: input.offerMode ?? '', duration: input.duration ?? '', numberOfPeriods: input.numberOfPeriods ?? 0, prices: input.prices });
    if (!OFFER_ELIGIBILITY.includes(input.offerEligibility ?? '')) throw new Error(`--offer-eligibility must be ${OFFER_ELIGIBILITY.join(' or ')}.`);
  } else {
    if (input.offerMode || input.duration || input.numberOfPeriods || input.offerEligibility) throw new Error('Mode, duration, periods and offer eligibility apply only to subscriptions.');
    if (!input.prices.length) throw new Error('In-app purchase offer codes need --prices.');
  }
  await ownedProduct(api, appId, kind, productId);
  const prices = await resolvePrices(api, kind, productId, input.prices);
  const existing = (await api.list(`${PRODUCT[kind].base}/${productId}/offerCodes?limit=200`, 2000)).data.find(row => row.attributes.name === name);
  const terms = kind === 'subscription' ? { offerEligibility: input.offerEligibility, offerMode: input.offerMode, duration: input.duration, numberOfPeriods: input.numberOfPeriods } : {};
  const preview = { dryRun: !execute, kind, productId, name, eligibility, ...terms, prices };
  if (existing) return { ...preview, status: 'exists' as const, offerCodeId: existing.id };
  if (!execute) return preview;
  const priceType = kind === 'iap' ? 'inAppPurchaseOfferPrices' : 'subscriptionOfferCodePrices';
  const created = await api.post(`/v1/${CODE_RESOURCE[kind]}`, { data: { type: CODE_RESOURCE[kind],
    attributes: { name, customerEligibilities: eligibility, ...terms },
    relationships: { [kind === 'iap' ? 'inAppPurchase' : 'subscription']: rel(PRODUCT[kind].parent, productId), prices: { data: prices.map((_, i) => ({ type: priceType, id: `\${price${i}}` })) } } },
    included: kind === 'iap' ? inlinePrices(priceType, 'inAppPurchasePricePoints', 'pricePoint', prices) : inlinePrices(priceType, 'subscriptionPricePoints', 'subscriptionPricePoint', prices) });
  return { ...preview, status: 'created' as const, offerCodeId: created.id };
}
async function ownedOfferCode(api: ExtrasAPI, appId: string, kind: ProductKind, productId: string, offerCodeId: string): Promise<Resource> {
  await ownedProduct(api, appId, kind, productId);
  const code = (await api.list(`${PRODUCT[kind].base}/${productId}/offerCodes?limit=200`, 2000)).data.find(row => row.id === offerCodeId);
  if (!code) throw new Error('Offer code does not belong to this product.');
  return code;
}
export async function setOfferCodeActive(input: { account: Account; appId: string; kind: ProductKind; productId: string; offerCodeId: string; active: boolean }, api: ExtrasAPI) {
  const { account, appId, kind, productId, offerCodeId, active } = input;
  requireWrite(account, appId);
  const code = await ownedOfferCode(api, appId, kind, productId, offerCodeId);
  if (code.attributes.active === active) return { offerCodeId, active, status: 'unchanged' as const };
  await api.patch(`/v1/${CODE_RESOURCE[kind]}/${offerCodeId}`, CODE_RESOURCE[kind], offerCodeId, { active });
  return { offerCodeId, active, status: 'updated' as const };
}
/** Writes text atomically and readable only by its owner; codes are redeemable value. */
async function writePrivate(path: string, text: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('--out must be an absolute path.');
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
/**
 * Generates single-use codes and saves them to a private file. Each run creates a new batch,
 * so it previews unless execute is set; a lost response must be checked before rerunning.
 */
export async function generateOneTimeCodes(input: { account: Account; appId: string; kind: ProductKind; productId: string; offerCodeId: string; count: number; expires: string; environment?: string; out: string; execute?: boolean }, api: ExtrasAPI) {
  const { account, appId, kind, productId, offerCodeId, count, expires, environment, out, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!Number.isInteger(count) || count < 1 || count > 150_000) throw new Error('Count must be a whole number from 1 to 150000.');
  if (!isDate(expires) || expires <= new Date().toISOString().slice(0, 10)) throw new Error('--expires must be a future date as YYYY-MM-DD.');
  if (environment !== undefined && !['PRODUCTION', 'SANDBOX'].includes(environment)) throw new Error('--environment must be PRODUCTION or SANDBOX.');
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
  await ownedOfferCode(api, appId, kind, productId, offerCodeId);
  const preview = { dryRun: !execute, offerCodeId, count, expires, environment: environment ?? 'PRODUCTION', out, effect: 'Creates a new batch of single-use codes every time it runs.' };
  if (!execute) return preview;
  if (!api.download) throw new Error('This client cannot download code values.');
  const resource = kind === 'iap' ? 'inAppPurchaseOfferCodeOneTimeUseCodes' : 'subscriptionOfferCodeOneTimeUseCodes';
  const batch = await api.post(`/v1/${resource}`, { data: { type: resource, attributes: { numberOfCodes: count, expirationDate: expires, ...(environment ? { environment } : {}) },
    relationships: { offerCode: rel(CODE_RESOURCE[kind], offerCodeId) } } });
  try {
    const values = (await api.download(`/v1/${resource}/${batch.id}/values`, 'text/csv')).toString('utf8');
    await writePrivate(out, values);
    return { ...preview, batchId: batch.id, out, sha256: createHash('sha256').update(values).digest('hex') };
  } catch (error) {
    // The batch exists at Apple even if saving failed; say how to fetch it rather than generating another.
    throw new Error(`${error instanceof Error ? error.message : 'Saving codes failed'} Batch ${batch.id} was created; download its values from App Store Connect instead of generating another batch.`);
  }
}
/** Creates a custom, human-readable code such as SPRING25 that many customers can redeem. */
export async function createCustomCode(input: { account: Account; appId: string; kind: ProductKind; productId: string; offerCodeId: string; customCode: string; count: number; expires?: string }, api: ExtrasAPI) {
  const { account, appId, kind, productId, offerCodeId, customCode, count, expires } = input;
  requireWrite(account, appId);
  if (!/^[A-Z0-9]{1,64}$/.test(customCode)) throw new Error('Custom code must be uppercase letters and digits.');
  if (!Number.isInteger(count) || count < 1 || count > 25_000) throw new Error('Count must be a whole number from 1 to 25000.');
  if (!isDate(expires)) throw new Error('--expires must be YYYY-MM-DD.');
  await ownedOfferCode(api, appId, kind, productId, offerCodeId);
  const resource = kind === 'iap' ? 'inAppPurchaseOfferCodeCustomCodes' : 'subscriptionOfferCodeCustomCodes';
  const existing = (await api.list(`/v1/${CODE_RESOURCE[kind]}/${offerCodeId}/customCodes?limit=200`, 2000)).data.find(row => row.attributes.customCode === customCode);
  if (existing) return { status: 'exists' as const, customCodeId: existing.id, customCode };
  const created = await api.post(`/v1/${resource}`, { data: { type: resource, attributes: { customCode, numberOfCodes: count, ...(expires ? { expirationDate: expires } : {}) },
    relationships: { offerCode: rel(CODE_RESOURCE[kind], offerCodeId) } } });
  return { status: 'created' as const, customCodeId: created.id, customCode };
}

// ---- Promoted purchases (shown on the App Store product page) ----
export async function setPromotedPurchase(input: { account: Account; appId: string; kind: ProductKind; productId: string; visibleForAllUsers?: boolean; enabled?: boolean }, api: ExtrasAPI) {
  const { account, appId, kind, productId, visibleForAllUsers, enabled } = input;
  requireWrite(account, appId);
  await ownedProduct(api, appId, kind, productId);
  const relation = kind === 'iap' ? 'inAppPurchaseV2' : 'subscription';
  const rows = await api.list(`/v1/apps/${appId}/promotedPurchases?limit=200&include=inAppPurchaseV2,subscription`, 2000);
  const existing = rows.data.find(row => linkedId(row, relation) === productId);
  const fields = Object.fromEntries(Object.entries({ visibleForAllUsers, enabled }).filter(([, v]) => v !== undefined));
  if (existing) {
    const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => existing.attributes[key] !== value));
    if (!Object.keys(changes).length) return { status: 'unchanged' as const, promotedPurchaseId: existing.id };
    await api.patch(`/v1/promotedPurchases/${existing.id}`, 'promotedPurchases', existing.id, changes);
    return { status: 'updated' as const, promotedPurchaseId: existing.id, changed: Object.keys(changes) };
  }
  const created = await api.post('/v1/promotedPurchases', { data: { type: 'promotedPurchases', attributes: { visibleForAllUsers: visibleForAllUsers ?? true, ...(enabled === undefined ? {} : { enabled }) },
    relationships: { app: rel('apps', appId), [relation]: rel(PRODUCT[kind].parent, productId) } } });
  return { status: 'created' as const, promotedPurchaseId: created.id };
}
export async function deletePromotedPurchase(input: { account: Account; appId: string; promotedPurchaseId: string }, api: ExtrasAPI): Promise<{ removed: string }> {
  const { account, appId, promotedPurchaseId } = input;
  requireWrite(account, appId);
  if (!(await api.list(`/v1/apps/${appId}/promotedPurchases?limit=200`, 2000)).data.some(row => row.id === promotedPurchaseId)) throw new Error('Promoted purchase does not belong to this app.');
  await api.delete(`/v1/promotedPurchases/${promotedPurchaseId}`);
  return { removed: promotedPurchaseId };
}

// ---- App Review screenshot for a product ----
/** Uploads the screenshot App Review uses to find the purchase, replacing any previous one. */
export async function uploadProductReviewScreenshot(input: { account: Account; appId: string; kind: ProductKind; productId: string; filePath: string }, api: ExtrasAPI, fetcher: typeof fetch = fetch) {
  const { account, appId, kind, productId, filePath } = input;
  requireWrite(account, appId);
  const { name, bytes, sha256 } = await readImage(filePath);
  await ownedProduct(api, appId, kind, productId);
  const resource = kind === 'iap' ? 'inAppPurchaseAppStoreReviewScreenshots' : 'subscriptionAppStoreReviewScreenshots';
  const current = await optional(api, `${PRODUCT[kind].base}/${productId}/appStoreReviewScreenshot`);
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (current?.attributes.sourceFileChecksum === md5) return { status: 'unchanged' as const, screenshotId: current.id };
  const body = { data: { type: resource, attributes: { fileName: name, fileSize: bytes.length },
    relationships: { [kind === 'iap' ? 'inAppPurchaseV2' : 'subscription']: rel(PRODUCT[kind].parent, productId) } } };
  let reserved: Resource;
  let removedFirst = false;
  try { reserved = await api.post(`/v1/${resource}`, body); }
  catch (error) {
    // A product holds one screenshot; if Apple refuses a second, remove the old one and try once more.
    if (!(error instanceof AppleError) || error.status !== 409 || !current) throw error;
    await api.delete(`/v1/${resource}/${current.id}`);
    removedFirst = true;
    reserved = await api.post(`/v1/${resource}`, body);
  }
  for (const op of validateOperations(reserved.attributes.uploadOperations, bytes.length)) await putFilePart(op, filePath, fetcher);
  await api.patch(`/v1/${resource}/${reserved.id}`, resource, reserved.id, { uploaded: true, sourceFileChecksum: md5 });
  // Remove the previous screenshot only after the new one is committed, so the product is never left without one.
  if (current && !removedFirst && current.id !== reserved.id) await api.delete(`/v1/${resource}/${current.id}`);
  return { status: 'uploaded' as const, screenshotId: reserved.id, replaced: current?.id ?? null, sha256 };
}
