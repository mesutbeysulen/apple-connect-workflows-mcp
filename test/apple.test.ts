import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AppleClient, createTokenProvider } from '../src/apple.js';
import { configSchema } from '../src/config.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
test('JWT is signed ES256 with correct audience and bounded lifetime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-auth-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const path = join(dir, 'key.p8');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const token = createTokenProvider({ name: 'test', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: path, readOnly: true, allowedAppIds: [] })();
    const [header, payload, signature] = token.split('.') as [string, string, string];
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.aud, 'appstoreconnect-v1');
    assert.equal(claims.exp - claims.iat, 600);
    assert(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  } finally { rmSync(dir, { recursive: true }); }
});
test('configuration defaults read-only and rejects duplicate account names', () => {
  const account = { name: 'test', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/tmp/key.p8' };
  assert.equal(configSchema.parse({ accounts: [account] }).accounts[0]!.readOnly, true);
  assert.throws(() => configSchema.parse({ accounts: [account, account] }));
});
test('never sends bearer token to foreign origin, including pagination', async () => {
  const calls: string[] = [];
  const api = new AppleClient(() => 'secret', (async url => { calls.push(String(url)); return json({ data: [], links: { next: 'https://evil.example/v1/apps' } }); }) as typeof fetch);
  await assert.rejects(api.get('https://evil.example/v1/apps'), /Refusing/);
  await assert.rejects(api.list('/v1/apps'), /Refusing/);
  assert.deepEqual(calls, ['https://api.appstoreconnect.apple.com/v1/apps']);
});
test('pagination aggregates pages and reports truncation', async () => {
  let count = 0;
  const api = new AppleClient(() => 'token', (async () => json(++count === 1 ? { data: [{ id: '1' }], links: { next: '/v1/apps?cursor=2' } } : { data: [{ id: '2' }, { id: '3' }] })) as typeof fetch);
  const result = await api.list('/v1/apps', 2);
  assert.deepEqual(result.data.map(r => r.id), ['1', '2']); assert.equal(result.truncated, true);
});
test('pagination cycles fail rather than reporting incomplete data as complete', async () => {
  const api = new AppleClient(() => 'token', (async () => json({ data: [], links: { next: '/v1/apps' } })) as typeof fetch);
  await assert.rejects(api.list('/v1/apps'), /cycle/);
});
test('read throttling retries; uncertain mutations never auto-retry; redirects disabled', async () => {
  let count = 0;
  const api = new AppleClient(() => 'token', (async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    assert(init?.signal);
    count++;
    return json({ errors: [{ code: 'RATE_LIMIT_EXCEEDED' }] }, 429, { 'retry-after': '0' });
  }) as typeof fetch, async () => {});
  await assert.rejects(api.list('/v1/apps'), /429/); assert.equal(count, 3);
  count = 0;
  await assert.rejects(api.patch('/v1/apps/1', 'apps', '1', {}), /429/); assert.equal(count, 1);
});
