import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlanStore } from '../src/plans.js';
import { ConnectService } from '../src/service.js';
import { createServer } from '../src/server.js';
import { smokeRead, findIds } from '../src/smoke.js';
import { appleRejects, assertReadablePath } from '../src/catalog.js';
import { AppleError, type AppleAPI, type Resource } from '../src/apple.js';
import type { Config } from '../src/config.js';

/** Fake Apple: every path answers with one resource typed after its last segment, and writes fail the test. */
function fakeApple(calls: string[], noCloud = false): AppleAPI {
  const resource = (path: string): Resource => {
    const segments = new URL(path, 'https://x').pathname.split('/').filter(Boolean);
    const last = segments.at(-1)!;
    const type = /^\d|-/.test(last) ? segments.at(-2)! : last;
    return { id: `${type}-1`, type, attributes: { bundleId: 'com.example.app', name: 'SECRET-VALUE', state: 'READY' }, relationships: { app: { data: { id: '123', type: 'apps' } } } };
  };
  return {
    get: async path => { calls.push(`GET ${path}`); if (path.startsWith('/v1/users')) throw new AppleError(403, ['FORBIDDEN_ERROR']); if (path.endsWith('/ciProduct') && noCloud) throw new AppleError(404, ['NOT_FOUND']); return resource(path); },
    list: async path => { calls.push(`LIST ${path}`); if (path.startsWith('/v1/users')) throw new AppleError(403, ['FORBIDDEN_ERROR']); if (path.includes('/diagnosticSignatures')) throw new AppleError(404, ['NOT_FOUND']); return { data: [resource(path)], truncated: false }; },
    patch: async () => { throw new Error('smoke-read must never write'); },
    download: async () => Buffer.from('{}'),
  };
}

test('smoke-read runs the read tools with discovered IDs, never writes and keeps only field names', { timeout: 20000 }, async () => {
  const store = new PlanStore(':memory:');
  const config: Config = { databasePath: ':memory:', accounts: [{ name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: true, allowedAppIds: [] }] };
  const calls: string[] = [];
  const service = new ConnectService(config, store, () => fakeApple(calls));
  try {
    const report = await smokeRead(createServer(service), { account: 'team', appId: '123' });
    assert.equal(report.appId, '123');
    const users = report.steps.find(s => s.tool === 'users_list')!;
    assert.equal(users.status, 'error');
    assert.equal(users.outcome, 'forbidden');
    assert.equal(report.summary.forbidden, report.steps.filter(s => s.outcome === 'forbidden').length);
    assert(report.summary.ok > 50, `only ${report.summary.ok} tools passed: ${JSON.stringify(report.steps.filter(s => s.status !== 'ok'))}`);
    assert(!JSON.stringify(report).includes('SECRET-VALUE'), 'the report must not carry attribute values');
    assert.deepEqual(report.steps.find(s => s.tool === 'app_info_get')?.status, 'ok');
    // Apple answers 404 for a build without diagnostics; the tool reports an empty list instead.
    assert.deepEqual(report.steps.find(s => s.tool === 'diagnostic_signatures_list')?.status, 'ok');
    assert(calls.includes('LIST /v1/appEncryptionDeclarations?filter[app]=123&limit=200'));
    assert(calls.every(c => c.startsWith('GET ') || c.startsWith('LIST ')));
    // Every read-only tool that needs no user-supplied ID is exercised.
    const readOnly = [...readFileSync(resolve('docs/mcp-tools.md'), 'utf8').split('## Read-only')[1]!.split('\n## ')[0]!.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]!);
    const needsUserInput = new Set(['workflow_plan_get', 'plan_get', 'api_plan_get', 'api_catalog_get', 'api_read', 'metadata_sync_preview', 'screenshot_status', 'creative_status']);
    const exercised = new Set(report.steps.map(s => s.tool));
    assert.deepEqual(readOnly.filter(t => !needsUserInput.has(t) && !exercised.has(t)), []);
  } finally { store.close(); }
});

test('smoke-read stops after a failed account check and reports why', { timeout: 20000 }, async () => {
  const store = new PlanStore(':memory:');
  const config: Config = { databasePath: ':memory:', accounts: [{ name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: true, allowedAppIds: [] }] };
  const api: AppleAPI = { get: async () => { throw new AppleError(401, []); }, list: async () => { throw new AppleError(401, []); }, patch: async () => { throw new Error('no writes'); } };
  const service = new ConnectService(config, store, () => api);
  try {
    const report = await smokeRead(createServer(service), { account: 'team' });
    assert.equal(report.steps.at(-1)!.tool, 'account_check');
    assert.equal(report.steps.at(-1)!.outcome, 'forbidden');
    // workflow_catalog starts dist/cli.js, which tsx test runs do not have; only Apple calls matter here.
    assert.deepEqual(report.steps.filter(s => s.status === 'error' && s.tool !== 'workflow_catalog').map(s => s.tool), ['account_check']);
  } finally { store.close(); }
});

test('an app without Xcode Cloud reads as disabled, not as an error', { timeout: 20000 }, async () => {
  const store = new PlanStore(':memory:');
  const config: Config = { databasePath: ':memory:', accounts: [{ name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: true, allowedAppIds: [] }] };
  const service = new ConnectService(config, store, () => fakeApple([], true));
  try {
    const report = await smokeRead(createServer(service), { account: 'team', appId: '123' });
    const overview = report.steps.find(s => s.tool === 'xcode_cloud_overview')!;
    assert.equal(overview.status, 'ok');
    assert.deepEqual(overview.fields, ['enabled', 'note']);
    assert.equal(report.steps.find(s => s.tool === 'xcode_cloud_build_run')?.status, 'skipped');
  } finally { store.close(); }
});

test('findIds walks nested results by resource type', () => {
  const value = { leaderboards: { data: [{ id: 'l1', type: 'gameCenterLeaderboards', relationships: { versions: { data: [{ id: 'v1', type: 'gameCenterLeaderboardVersions' }] } } }] } };
  assert.deepEqual(findIds(value, ['gameCenterLeaderboards']), ['l1']);
  assert.deepEqual(findIds(value, ['gameCenterLeaderboardVersions']), ['v1']);
});

test('requests the live API rejects are refused with the working alternative', () => {
  assert.match(appleRejects('GET', '/v1/apps/123/appEncryptionDeclarations?limit=200')!, /filter\[app\]/);
  assert.match(appleRejects('GET', '/v1/bundleIds/B/bundleIdCapabilities?limit=200')!, /limit/);
  assert.equal(appleRejects('GET', '/v1/bundleIds/B/bundleIdCapabilities'), undefined);
  assert.equal(appleRejects('GET', '/v1/appEncryptionDeclarations?filter[app]=123'), undefined);
  assert.throws(() => assertReadablePath('/v1/apps/123/appEncryptionDeclarations'), /PATH_ERROR/);
});
