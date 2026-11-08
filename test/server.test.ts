import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('real stdio handshake lists all read tools, returns accounts and rejects invalid inputs without credentials', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-mcp-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ databasePath: join(dir, 'plans.sqlite'), accounts: [{ name: 'demo', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: join(dir, 'nonexistent.p8') }] }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'serve', '--config', config], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert.equal(listing.tools.length, 38);
    assert(listing.tools.every(t => t.name === 'metadata_plan' || t.annotations?.readOnlyHint === true));
    assert(!listing.tools.some(t => /apply|execute|delete|upload$|order/.test(t.name)));
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
