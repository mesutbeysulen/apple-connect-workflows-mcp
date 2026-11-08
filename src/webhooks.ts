import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import type { PlanStore } from './plans.js';

export interface WebhookAPI {
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  delete(path: string): Promise<void>;
}
export const WEBHOOK_SECRET_ENV = 'APPLE_WEBHOOK_SECRET';
const MAX_BODY = 1024 * 1024;
/** Secrets are read from the environment only, so they stay out of shell history and process lists. */
export function webhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env[WEBHOOK_SECRET_ENV];
  if (!secret || secret.length < 16) throw new Error(`Set ${WEBHOOK_SECRET_ENV} to a secret of at least 16 characters.`);
  return secret;
}
const validId = (id: string) => /^[A-Za-z0-9-]{1,128}$/.test(id);
async function ownedWebhook(api: WebhookAPI, appId: string, webhookId: string): Promise<Resource> {
  const hooks = await api.list(`/v1/apps/${appId}/webhooks?limit=200`, 200);
  const hook = hooks.data.find(row => row.id === webhookId);
  if (!hook) throw new Error('Webhook does not belong to this app.');
  return hook;
}
export async function createWebhook(input: { account: Account; appId: string; name: string; url: string; events: string[]; secret: string }, api: WebhookAPI): Promise<{ status: 'exists' | 'created'; webhookId: string }> {
  const { account, appId, name, url, events, secret } = input;
  requireWrite(account, appId);
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Webhook URL must be HTTPS without embedded credentials.');
  if (!name || name.length > 128 || !events.length || !events.every(e => /^[A-Z_]{3,100}$/.test(e))) throw new Error('Provide a name and at least one Apple webhook event type.');
  const hooks = await api.list(`/v1/apps/${appId}/webhooks?limit=200`, 200);
  const found = hooks.data.find(row => row.attributes.name === name && row.attributes.url === target.toString());
  if (found) return { status: 'exists', webhookId: found.id };
  const created = await api.post('/v1/webhooks', { data: { type: 'webhooks', attributes: { name, url: target.toString(), eventTypes: events, secret, enabled: true }, relationships: { app: { data: { type: 'apps', id: appId } } } } });
  return { status: 'created', webhookId: created.id };
}
export async function setWebhookEnabled(input: { account: Account; appId: string; webhookId: string; enabled: boolean }, api: WebhookAPI): Promise<{ webhookId: string; enabled: boolean }> {
  const { account, appId, webhookId, enabled } = input;
  requireWrite(account, appId);
  await ownedWebhook(api, appId, webhookId);
  await api.patch(`/v1/webhooks/${webhookId}`, 'webhooks', webhookId, { enabled });
  return { webhookId, enabled };
}
export async function pingWebhook(input: { account: Account; appId: string; webhookId: string }, api: WebhookAPI): Promise<{ pingId: string }> {
  const { account, appId, webhookId } = input;
  requireWrite(account, appId);
  await ownedWebhook(api, appId, webhookId);
  return { pingId: (await api.post('/v1/webhookPings', { data: { type: 'webhookPings', relationships: { webhook: { data: { type: 'webhooks', id: webhookId } } } } })).id };
}
export async function redeliverWebhook(input: { account: Account; appId: string; webhookId: string; deliveryId: string }, api: WebhookAPI): Promise<{ deliveryId: string }> {
  const { account, appId, webhookId, deliveryId } = input;
  requireWrite(account, appId);
  if (!validId(deliveryId)) throw new Error('Invalid delivery ID.');
  await ownedWebhook(api, appId, webhookId);
  const deliveries = await api.list(`/v1/webhooks/${webhookId}/deliveries?limit=200`, 2000);
  if (!deliveries.data.some(row => row.id === deliveryId)) throw new Error('Delivery does not belong to this webhook.');
  return { deliveryId: (await api.post('/v1/webhookDeliveries', { data: { type: 'webhookDeliveries', relationships: { template: { data: { type: 'webhookDeliveries', id: deliveryId } } } } })).id };
}
export async function deleteWebhook(input: { account: Account; appId: string; webhookId: string }, api: WebhookAPI): Promise<{ deleted: string }> {
  const { account, appId, webhookId } = input;
  requireWrite(account, appId);
  await ownedWebhook(api, appId, webhookId);
  await api.delete(`/v1/webhooks/${webhookId}`);
  return { deleted: webhookId };
}
/** Checks Apple's x-apple-signature header (hmacsha256=<hex>) against the raw request body. */
export function verifySignature(body: Buffer, header: string | undefined, secret: string): boolean {
  const match = header?.match(/^hmacsha256=([0-9a-fA-F]{64})$/);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, 'hex'));
}
/** Local receiver: stores only signature-verified events. Expose it through your own HTTPS tunnel or proxy. */
export function webhookReceiver(secret: string, store: PlanStore): Server {
  return createServer((request, response) => {
    const finish = (status: number) => { response.writeHead(status).end(); };
    if (request.method !== 'POST') return finish(405);
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { finish(413); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const header = request.headers['x-apple-signature'];
      if (!verifySignature(body, Array.isArray(header) ? header[0] : header, secret)) return finish(401);
      try { store.saveWebhookEvent(body.toString('utf8')); finish(200); } catch { finish(500); }
    });
  });
}
