import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('real stdio handshake lists workflows, returns accounts and rejects invalid inputs without credentials', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-mcp-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ databasePath: join(dir, 'plans.sqlite'), accounts: [{ name: 'demo', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: join(dir, 'nonexistent.p8') }] }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'serve', '--config', config], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert(listing.tools.length >= 55);
    assert(listing.tools.some(t => t.name === 'product_versions_list'));
    assert(listing.tools.some(t => t.name === 'product_version_localizations'));
    assert(listing.tools.some(t => t.name === 'workflow_apply' && t.annotations?.destructiveHint === true));
    assert(listing.tools.some(t => t.name === 'workflow_prepare'));
    const accounts = await client.callTool({ name: 'accounts_list', arguments: {} });
    assert.equal(accounts.isError, undefined);
    assert(!JSON.stringify(accounts).includes('nonexistent.p8'));
    assert(JSON.stringify(accounts).includes('demo'));
    const invalid = await client.callTool({ name: 'metadata_plan', arguments: { account: 'demo', appId: '../users', versionId: 'x', localizations: [] } });
    assert.equal(invalid.isError, true);
    const catalog = await client.callTool({ name: 'api_catalog_search', arguments: { query: 'reviewSubmissions' } });
    assert(JSON.stringify(catalog).includes('/v1/reviewSubmissions'));
    const offCatalog = await client.callTool({ name: 'api_read', arguments: { account: 'demo', path: '/v1/nonsense' } });
    assert.equal(offCatalog.isError, true);
    const events = await client.callTool({ name: 'webhook_events_list', arguments: {} });
    assert.equal(events.isError, undefined);
    const unavailable = await client.callTool({ name: 'plan_get', arguments: { planId: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(unavailable.isError, true);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real CLI audits denials with journal context and enforces the write lease', { timeout: 20000 }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { execFile } = await import('node:child_process');
  const { userInfo } = await import('node:os');
  const { accountIdentity, configSchema } = await import('../src/config.js');
  const dir = mkdtempSync(join(tmpdir(), 'apple-cli-'));
  const db = join(dir, 'plans.sqlite');
  const keyPath = join(dir, 'k.p8');
  const account = { name: 'demo', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: keyPath, readOnly: false, allowedAppIds: ['123'] };
  const write = (operators: unknown) => { const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify({ databasePath: db, accounts: [account], operators })); return path; };
  const run = (config: string, ...args: string[]) => new Promise<{ code: number; stderr: string; stdout: string }>(done => execFile(process.execPath, [resolve('dist/cli.js'), args[0]!, '--config', config, ...args.slice(1)], { timeout: 15000 }, (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stderr, stdout })));
  try {
    const me = userInfo().username;
    const denied = await run(write([{ user: me, accounts: ['demo'], capabilities: ['upload'] }]), 'release-publish', '--account', 'demo', '--app', '123', '--version', 'v', '--version-string', '1.0');
    assert.equal(denied.code, 1); assert.match(denied.stderr, /lacks the release capability/);
    const log = JSON.parse((await run(write(undefined), 'audit')).stdout);
    assert.deepEqual([log[0].command, log[0].account, log[0].app_id, log[0].ok], ['release-publish', 'demo', '123', 0]);
    const database = new DatabaseSync(db);
    const identity = accountIdentity(configSchema.parse({ accounts: [account] }).accounts[0]!);
    database.prepare('INSERT INTO leases(scope,owner,expires) VALUES (?,?,?)').run(`${identity}:123`, 'other', Date.now() + 60_000);
    database.close();
    const busy = await run(write(undefined), 'asset-order', '--account', 'demo', '--app', '123', '--version', 'v', '--localization', 'l', '--placement-group', 'G', '--order', 'a,b');
    assert.equal(busy.code, 1); assert.match(busy.stderr, /Another operation is active/);
    const preview = await run(write(undefined), 'iap-price-set', '--account', 'demo', '--app', '123', '--iap', '../x', '--territory', 'USA', '--price', '1');
    assert.match(preview.stderr, /valid in-app purchase ID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
