import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebhook, deleteWebhook, pingWebhook, redeliverWebhook, setWebhookEnabled, verifySignature, webhookReceiver, webhookSecret } from '../src/webhooks.js';
import { setupKey } from '../src/key-setup.js';
import { configSchema, requireCapability } from '../src/config.js';
import { assertReadablePath, redactSecrets, searchCatalog } from '../src/catalog.js';
import { AppleClient } from '../src/apple.js';
import { PlanStore } from '../src/plans.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const secret = 'a-long-enough-secret';
const hooks = () => fakeApi({ '/v1/apps/123/webhooks': [res('w1', 'webhooks', { name: 'ci', url: 'https://hooks.example/a' })], '/v1/webhooks/w1/deliveries': [res('d1', 'webhookDeliveries')] }, { post: (_p, b) => res('created', b.data.type) });
test('webhook creation requires HTTPS, reuses matches and never returns the secret', async () => {
  const f = hooks();
  const input = { account, appId: '123', name: 'new', url: 'https://hooks.example/b', events: ['BUILD_UPLOAD_STATE_UPDATED'], secret };
  const result = await createWebhook(input, f.api);
  assert.deepEqual(result, { status: 'created', webhookId: 'created' });
  assert(!JSON.stringify(result).includes(secret));
  assert.equal((f.writes()[0]!.body as any).data.attributes.secret, secret);
  assert.equal((await createWebhook({ ...input, name: 'ci', url: 'https://hooks.example/a' }, f.api)).status, 'secret_updated');
  assert.deepEqual(f.writes().at(-1)!.body, { secret });
  await assert.rejects(createWebhook({ ...input, url: 'http://hooks.example/b' }, f.api), /HTTPS/);
  await assert.rejects(createWebhook({ ...input, url: 'https://u:p@hooks.example/b' }, f.api), /HTTPS/);
  await assert.rejects(createWebhook({ ...input, account: readOnly }, f.api), /read-only/);
  assert.throws(() => webhookSecret({ APPLE_WEBHOOK_SECRET: 'short' }), /at least 16/);
});
test('webhook changes verify ownership first', async () => {
  const f = hooks();
  const base = { account, appId: '123', webhookId: 'w1' };
  assert.equal((await setWebhookEnabled({ ...base, enabled: false }, f.api)).enabled, false);
  assert.equal((await pingWebhook(base, f.api)).pingId, 'created');
  assert.equal((await redeliverWebhook({ ...base, deliveryId: 'd1' }, f.api)).deliveryId, 'created');
  assert.deepEqual(await deleteWebhook(base, f.api), { deleted: 'w1' });
  const before = f.writes().length;
  await assert.rejects(deleteWebhook({ ...base, webhookId: 'other' }, f.api), /does not belong/);
  await assert.rejects(redeliverWebhook({ ...base, deliveryId: 'unknown' }, f.api), /does not belong/);
  assert.equal(f.writes().length, before);
});
const sign = (body: string) => `hmacsha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
test('signature check accepts only the exact body and secret', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, sign('{"a":1}'), secret), true);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), sign('{"a":1}'), secret), false);
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, 'hmacsha256=zz', secret), false);
});
test('receiver stores only verified events', async () => {
  const store = new PlanStore(':memory:');
  const server = webhookReceiver(secret, store);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const send = (body: string, signature?: string, method = 'POST') => fetch(`http://127.0.0.1:${port}/`, { method, ...(method === 'POST' ? { body } : {}), headers: signature ? { 'x-apple-signature': signature } : {} });
  try {
    assert.equal((await send('{"ok":1}', sign('{"ok":1}'))).status, 200);
    assert.equal((await send('{"evil":1}', sign('{"ok":1}'))).status, 401);
    assert.equal((await send('{"evil":1}')).status, 401);
    assert.equal((await send('', undefined, 'GET')).status, 405);
    assert.deepEqual(store.webhookEvents().map(e => e.payload), ['{"ok":1}']);
  } finally { await new Promise(r => server.close(r)); store.close(); }
});
test('key setup stores a private copy, defaults to read-only and keeps other accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const p8Path = join(dir, 'AuthKey_ABCDEFGHIJ.p8'); const configPath = join(dir, 'config.json'); const keysDir = join(dir, 'keys');
  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(p8Path, pem);
  const issuerId = '11111111-1111-4111-8111-111111111111';
  try {
    const result = setupKey({ name: 'main', issuerId, p8Path, configPath, keysDir });
    assert.equal(result.keyId, 'ABCDEFGHIJ'); assert.equal(result.readOnly, true);
    assert(!JSON.stringify(result).includes('PRIVATE KEY'));
    assert.equal(statSync(result.privateKeyPath).mode & 0o777, 0o600);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.throws(() => setupKey({ name: 'main', issuerId, p8Path, configPath, keysDir }), /already exists/);
    assert.equal(setupKey({ name: 'second', issuerId, p8Path, configPath, keysDir, allowedAppIds: ['123'] }).readOnly, false);
    const saved = configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
    assert.deepEqual(saved.accounts.map(a => a.name), ['main', 'second']);
    assert(!readFileSync(configPath, 'utf8').includes('PRIVATE KEY'));
    assert(result.next.some(n => /delete the original/.test(n)));
    const stored = setupKey({ name: 'third', issuerId, p8Path: result.privateKeyPath, configPath, keysDir });
    assert(!stored.next.some(n => /delete the original/.test(n)));
    const rsa = join(dir, 'AuthKey_ZZZZZZZZZZ.p8');
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => setupKey({ name: 'bad', issuerId, p8Path: rsa, configPath, keysDir }), /ES256/);
    writeFileSync(rsa, 'garbage');
    assert.throws(() => setupKey({ name: 'bad', issuerId, p8Path: rsa, configPath, keysDir }), /not a readable/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('operator policy limits users by account and capability; absent policy changes nothing', () => {
  const accounts = [{ name: 'main', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/k' }];
  const open = configSchema.parse({ accounts });
  requireCapability(open, 'anyone', 'main', 'release');
  const config = configSchema.parse({ accounts, operators: [{ user: 'dev', accounts: ['main'], capabilities: ['upload'] }, { user: 'lead', accounts: ['*'], capabilities: ['release'] }] });
  requireCapability(config, 'dev', 'main', 'upload');
  requireCapability(config, 'lead', 'other', 'release');
  assert.throws(() => requireCapability(config, 'dev', 'main', 'release'), /lacks the release/);
  assert.throws(() => requireCapability(config, 'dev', 'other', 'upload'), /lacks/);
  assert.throws(() => requireCapability(config, 'stranger', 'main', 'upload'), /lacks/);
  assert.throws(() => configSchema.parse({ accounts, operators: [{ user: 'x', accounts: ['main'], capabilities: ['root'] }] }));
});
test('audit log records outcomes', () => {
  const store = new PlanStore(':memory:');
  try {
    store.audit({ osUser: 'dev', command: 'release-publish', account: 'main', appId: '1', ok: false, error: 'nope' });
    assert.deepEqual(store.auditLog().map(r => [r.os_user, r.command, r.ok, r.error]), [['dev', 'release-publish', 0, 'nope']]);
  } finally { store.close(); }
});
test('catalog search finds endpoints and generic reads stay on real GET endpoints', () => {
  const found = searchCatalog('assetLibrary placements', 'POST');
  assert(found.endpoints.some(e => e.path === '/v1/appAssetLibraryPlacements'));
  assert.equal(found.apiVersion, '4.6');
  assertReadablePath('/v1/apps/123/appInfos?limit=5');
  assert.throws(() => assertReadablePath('/v1/nonsense'), /not a GET endpoint/);
  assert.throws(() => assertReadablePath('/v1/appStoreVersionReleaseRequests'), /not a GET endpoint/);
  assert.throws(() => assertReadablePath('https://evil.example/v1/apps'), /API path/);
  assert.throws(() => assertReadablePath('//evil.example/v1/apps'), /API path/);
});
test('credentials are redacted from anything shown to a model', () => {
  const value = { data: { id: 'r', attributes: { contactEmail: 'a@x', demoAccountName: 'demo', demoAccountPassword: 'hunter2', secret: 's', certificateContent: 'c', notes: 'n', empty: null } }, rows: [{ profileContent: 'p', name: 'ok' }] };
  const text = JSON.stringify(redactSecrets(value));
  for (const hidden of ['hunter2', '"demo"', '"s"', '"c"', '"p"']) assert(!text.includes(hidden), hidden);
  for (const kept of ['a@x', '"n"', '"ok"']) assert(text.includes(kept), kept);
});
test('client downloads retry on throttling like other reads', async () => {
  let calls = 0;
  const client = new AppleClient(() => 'token', (async () => ++calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '0' } }) : new Response('data')) as unknown as typeof fetch, async () => {});
  assert.equal((await client.download('/v1/salesReports?x=1', 'a/b')).toString(), 'data');
  assert.equal(calls, 2);
});
test('client allows versioned API paths on the Apple origin only', async () => {
  const seen: string[] = [];
  const client = new AppleClient(() => 'token', (async (url: URL) => { seen.push(url.toString()); return new Response(JSON.stringify({ data: { id: 'x', type: 't', attributes: {} } })); }) as unknown as typeof fetch);
  await client.get('/v2/inAppPurchases/1');
  assert.equal(seen[0], 'https://api.appstoreconnect.apple.com/v2/inAppPurchases/1');
  await assert.rejects(client.get('/internal/x'), /Refusing/);
  await assert.rejects(client.get('https://evil.example/v1/apps'), /Refusing/);
  await assert.rejects(client.download('https://evil.example/v1/salesReports', 'a/b'), /Refusing/);
});
