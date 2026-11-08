import { accountIdentity, requireWrite, type Account } from './config.js';
import { AppleError } from './apple.js';
import { matchEndpoint, redactSecrets } from './catalog.js';
import type { ApiPlan, PlanStore } from './plans.js';
import { assertValidBody } from './schema-check.js';

const LIFETIME_MS = 30 * 60_000;
export interface ApiPlanInput { account: Account; appId: string; method: string; path: string; requestBody?: unknown; note?: string; allowSecrets?: boolean }
/**
 * Records one write to any catalog endpoint for human review. Nothing reaches Apple here.
 * The method and path must exist in Apple's catalog, and the body must match its schema.
 */
export function createApiPlan(input: ApiPlanInput, store: PlanStore): ApiPlan {
  const { account, appId, method, path, requestBody, note = '', allowSecrets = false } = input;
  if (!/^\d+$/.test(appId)) throw new Error('appId must be the numeric app this write is for.');
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('Use POST, PATCH or DELETE.');
  const endpoint = matchEndpoint(method, path);
  if (!endpoint) throw new Error(`${method} ${path} is not in the API catalog. Use api_catalog_search.`);
  if (endpoint.body) {
    assertValidBody(endpoint.body, requestBody);
  } else if (requestBody !== undefined && requestBody !== null) throw new Error('This endpoint takes no request body.');
  // Text in a model's plan call is already in its transcript, so credentials must not travel this way.
  if (!allowSecrets && JSON.stringify(redactSecrets(requestBody ?? null)) !== JSON.stringify(requestBody ?? null)) {
    throw new Error('Request contains a credential field. Use the dedicated CLI command, which reads it from the environment.');
  }
  const now = Date.now();
  return store.createApiPlan({ account: account.name, identity: accountIdentity(account), appId, method, path, requestBody: requestBody ?? null, note: note.slice(0, 500), createdAt: now, expiresAt: now + LIFETIME_MS });
}
/** A generic write has no reliable "already done" check, so an unknown outcome is never retried automatically. */
export async function applyApiPlan(id: string, expectedDigest: string, account: Account, store: PlanStore,
  api: { request(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> }): Promise<ApiPlan> {
  const plan = store.apiPlan(id);
  if (plan.digest !== expectedDigest) throw new Error('Digest does not match the reviewed plan.');
  if (plan.body.account !== account.name || plan.body.identity !== accountIdentity(account)) throw new Error('Account credentials changed; prepare a new plan.');
  if (!account.genericWrites) throw new Error('Generic writes are off for this account. Set genericWrites: true in local configuration to allow api-apply.');
  requireWrite(account, plan.body.appId);
  if (plan.status === 'completed') return plan;
  if (plan.status === 'uncertain') throw new Error('The last attempt has an unknown outcome and may have reached Apple. Check the remote state, then prepare a new plan if needed.');
  if (Date.now() >= plan.body.expiresAt) throw new Error('Plan expired; prepare a new one.');
  if (!store.claimApiPlan(id)) throw new Error(`Plan cannot run from status ${plan.status}.`);
  try {
    const result = await api.request(plan.body.method as 'POST' | 'PATCH' | 'DELETE', plan.body.path, plan.body.requestBody ?? undefined);
    store.finishApiPlan(id, 'completed', result, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    // Apple answered with a refusal, so nothing was changed; any other failure leaves the outcome unknown.
    store.finishApiPlan(id, error instanceof AppleError && error.status < 500 ? 'failed' : 'uncertain', undefined, message);
    throw error;
  }
  return store.apiPlan(id);
}
