import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import { validId } from './apple-rules.js';
import { appSubscription, pricePoint, type CommercialAPI } from './commercial.js';

export const OFFER_MODES = ['FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT'];
export const OFFER_DURATIONS = ['THREE_DAYS', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];
export interface IntroOfferInput {
  account: Account; appId: string; subscriptionId: string; territory: string;
  offerMode: string; duration: string; numberOfPeriods: number; price?: string;
  startDate?: string; endDate?: string; replace?: boolean; execute?: boolean;
}
const date = /^\d{4}-\d{2}-\d{2}$/;
const linked = (row: Resource, relation: string) => { const data = row.relationships?.[relation]?.data; return data && !Array.isArray(data) ? data.id : undefined; };
const summary = (row: Resource) => ({ id: row.id, offerMode: row.attributes.offerMode, duration: row.attributes.duration, numberOfPeriods: row.attributes.numberOfPeriods,
  startDate: row.attributes.startDate ?? null, endDate: row.attributes.endDate ?? null, pricePointId: linked(row, 'subscriptionPricePoint') ?? null });

/**
 * Sets the introductory offer (free trial or discounted start) for one territory of a subscription.
 * Previews unless execute is set. An existing different offer is replaced only with replace.
 */
export async function setIntroOffer(input: IntroOfferInput, api: CommercialAPI & { delete(path: string): Promise<void> }) {
  const { account, appId, subscriptionId, territory, offerMode, duration, numberOfPeriods, price, startDate, endDate, replace = false, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (!validId(subscriptionId) || !/^[A-Z]{3}$/.test(territory)) throw new Error('Use a valid subscription ID and a three-letter territory such as USA.');
  if (!OFFER_MODES.includes(offerMode)) throw new Error(`Offer mode must be one of ${OFFER_MODES.join(', ')}.`);
  if (!OFFER_DURATIONS.includes(duration)) throw new Error(`Duration must be one of ${OFFER_DURATIONS.join(', ')}.`);
  if (!Number.isInteger(numberOfPeriods) || numberOfPeriods < 1 || numberOfPeriods > 12) throw new Error('Number of periods must be a whole number from 1 to 12.');
  // A free trial has no price; a paid offer must name one, so a forgotten price never becomes a free offer.
  if ((offerMode === 'FREE_TRIAL') !== (price === undefined)) throw new Error(offerMode === 'FREE_TRIAL' ? 'A free trial takes no --price.' : 'Paid offers need --price.');
  if ([startDate, endDate].some(d => d !== undefined && !date.test(d))) throw new Error('Dates must be YYYY-MM-DD.');
  if (startDate && endDate && endDate <= startDate) throw new Error('End date must be after the start date.');
  await appSubscription(api, appId, subscriptionId);
  const pricePointId = price === undefined ? null : await pricePoint(api, `/v1/subscriptions/${subscriptionId}/pricePoints`, territory, price);
  const query = new URLSearchParams({ 'filter[territory]': territory, include: 'subscriptionPricePoint,territory', limit: '200' });
  const existing = await api.list(`/v1/subscriptions/${subscriptionId}/introductoryOffers?${query}`, 200);
  if (existing.truncated) throw new Error('Incomplete introductory offer list; refusing to change offers.');
  const wanted = { offerMode, duration, numberOfPeriods, startDate: startDate ?? null, endDate: endDate ?? null, pricePointId };
  const same = existing.data.find(row => JSON.stringify(summary(row)).replace(/"id":"[^"]*",/, '') === JSON.stringify(wanted));
  const preview = { dryRun: !execute, subscriptionId, territory, offer: wanted, current: existing.data.map(summary),
    effect: existing.data.length && !same ? (replace ? 'Removes the current offer for this territory, then creates the new one.' : 'A different offer exists; pass --replace to swap it.') : 'Creates the offer for new subscribers in this territory.' };
  if (same) return { ...preview, status: 'exists' as const, offerId: same.id };
  if (!execute) return preview;
  if (existing.data.length && !replace) throw new Error(`Territory ${territory} already has offer ${existing.data.map(r => r.id).join(', ')}. Pass --replace to swap it.`);
  for (const row of existing.data) await api.delete(`/v1/subscriptionIntroductoryOffers/${row.id}`);
  const created = await api.post('/v1/subscriptionIntroductoryOffers', { data: { type: 'subscriptionIntroductoryOffers',
    attributes: { offerMode, duration, numberOfPeriods, ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) },
    relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } }, territory: { data: { type: 'territories', id: territory } },
      ...(pricePointId ? { subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pricePointId } } } : {}) } } });
  return { ...preview, status: 'created' as const, offerId: created.id, removed: existing.data.map(r => r.id) };
}
/** Removes one introductory offer after checking it belongs to this app's subscription. */
export async function deleteIntroOffer(input: { account: Account; appId: string; subscriptionId: string; offerId: string }, api: CommercialAPI & { delete(path: string): Promise<void> }): Promise<{ removed: string }> {
  const { account, appId, subscriptionId, offerId } = input;
  requireWrite(account, appId);
  if (![subscriptionId, offerId].every(validId)) throw new Error('Invalid subscription or offer ID.');
  await appSubscription(api, appId, subscriptionId);
  const offers = await api.list(`/v1/subscriptions/${subscriptionId}/introductoryOffers?limit=200`, 2000);
  if (!offers.data.some(row => row.id === offerId)) throw new Error('Offer does not belong to this subscription.');
  await api.delete(`/v1/subscriptionIntroductoryOffers/${offerId}`);
  return { removed: offerId };
}
