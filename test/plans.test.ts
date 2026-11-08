import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanStore } from '../src/plans.js';
import { ConnectService, prepareSchema } from '../src/service.js';
import type { AppleAPI, Resource } from '../src/apple.js';
import type { Config } from '../src/config.js';

function fixture(store = new PlanStore(':memory:')) {
  const config: Config = { databasePath: ':memory:', accounts: [{ name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] }] };
  const remote: Resource = { id: 'loc-1', type: 'appStoreVersionLocalizations', attributes: { locale: 'en-US', whatsNew: 'Old', description: 'Keep this' } };
  let state = 'PREPARE_FOR_SUBMISSION';
  let patches = 0;
  let loseResponse = false;
  const api: AppleAPI = {
    get: async path => structuredClone(path.includes('appStoreVersionLocalizations') ? remote : { id: 'v1', type: 'appStoreVersions', attributes: { appStoreState: state }, relationships: { app: { data: { id: '123', type: 'apps' } } } }),
    list: async () => ({ data: [structuredClone(remote)], truncated: false }),
    patch: async (_path, _type, _id, attrs) => { patches++; Object.assign(remote.attributes, attrs); if (loseResponse) { loseResponse = false; throw new Error('Network response lost'); } return {}; },
  };
  const service = new ConnectService(config, store, () => api);
  const input = { account: 'team', appId: '123', versionId: 'v1', localizations: [{ locale: 'en-US', changes: { whatsNew: 'New' } }] };
  return { service, store, config, remote, input, get patches() { return patches; }, setState: (s: string) => state = s, loseResponse: () => loseResponse = true };
}
test('plan captures exact diff without writing and persists across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-plan-')); const path = join(dir, 'plans.sqlite');
  const f = fixture(new PlanStore(path));
  try {
    const plan = await f.service.prepare(f.input);
    assert.equal(f.patches, 0); assert.deepEqual(plan.body.steps[0]!.before, { whatsNew: 'Old' });
    f.store.close();
    const next = new PlanStore(path);
    try { assert.deepEqual(next.get(plan.id), plan); } finally { next.close(); }
  } finally { rmSync(dir, { recursive: true }); }
});
test('apply changes requested fields only, verifies remote result, and is repeat-safe', async () => {
  const f = fixture();
  try {
    const plan = await f.service.prepare(f.input);
    assert.equal((await f.service.apply(plan.id, plan.digest)).status, 'completed');
    await f.service.apply(plan.id, plan.digest);
    assert.equal(f.patches, 1); assert.equal(f.remote.attributes.description, 'Keep this');
  } finally { f.store.close(); }
});
test('stale metadata is rejected before mutation', async () => {
  const f = fixture();
  try {
    const plan = await f.service.prepare(f.input); f.remote.attributes.whatsNew = 'Someone else';
    await assert.rejects(f.service.apply(plan.id, plan.digest), /Conflict/);
    assert.equal(f.patches, 0); assert.equal(f.store.get(plan.id).status, 'needs_reconciliation');
  } finally { f.store.close(); }
});
test('lost PATCH response is reconciled on retry with no duplicate write', async () => {
  const f = fixture();
  try {
    const plan = await f.service.prepare(f.input); f.loseResponse();
    await assert.rejects(f.service.apply(plan.id, plan.digest), /response lost/);
    assert.equal(f.store.get(plan.id).status, 'needs_reconciliation');
    assert.equal((await f.service.apply(plan.id, plan.digest)).status, 'completed');
    assert.equal(f.patches, 1);
  } finally { f.store.close(); }
});
test('digest, write policy, app allowlist, account identity, expiry and version state are enforced', async () => {
  const f = fixture();
  try {
    const plan = await f.service.prepare(f.input);
    await assert.rejects(f.service.apply(plan.id, 'wrong'), /Digest/);
    f.config.accounts[0]!.readOnly = true;
    await assert.rejects(f.service.apply(plan.id, plan.digest), /read-only/);
    f.config.accounts[0]!.readOnly = false; f.config.accounts[0]!.allowedAppIds = [];
    await assert.rejects(f.service.apply(plan.id, plan.digest), /allowlist/);
    f.config.accounts[0]!.allowedAppIds = ['123']; f.config.accounts[0]!.keyId = 'DIFFERENT0';
    await assert.rejects(f.service.apply(plan.id, plan.digest), /credentials changed/);
    f.config.accounts[0]!.keyId = 'ABCDEFGHIJ'; f.setState('IN_REVIEW');
    await assert.rejects(f.service.apply(plan.id, plan.digest), /not editable/);
    const expired = f.store.create({ ...plan.body, expiresAt: Date.now() - 1 });
    await assert.rejects(f.service.apply(expired.id, expired.digest), /expired/);
    assert.equal(f.patches, 0);
  } finally { f.store.close(); }
});
test('a lease blocks concurrent plans for the same account and app', async () => {
  const f = fixture();
  try {
    const one = await f.service.prepare(f.input); const two = await f.service.prepare(f.input);
    const lease = f.store.acquire(one);
    await assert.rejects(f.service.apply(two.id, two.digest), /Another operation/);
    f.store.release(lease);
    assert.equal((await f.service.apply(two.id, two.digest)).status, 'completed');
  } finally { f.store.close(); }
});
test('schema rejects unknown fields, duplicate locales, overlong Unicode keywords and path traversal', () => {
  const f = fixture();
  try {
    assert.throws(() => prepareSchema.parse({ ...f.input, appId: '../users' }));
    assert.throws(() => prepareSchema.parse({ ...f.input, localizations: [...f.input.localizations, ...f.input.localizations] }));
    for (const changes of [{ unsupported: 'x' }, {}, { keywords: 'ü'.repeat(51) }]) {
      assert.throws(() => prepareSchema.parse({ ...f.input, localizations: [{ locale: 'en-US', changes }] }));
    }
  } finally { f.store.close(); }
});
test('multi-locale failure preserves completed steps and resumes only remaining writes', async () => {
  const f = fixture();
  const remote = [
    { id: 'loc-en', type: 'appStoreVersionLocalizations', attributes: { locale: 'en-US', whatsNew: 'Old' } },
    { id: 'loc-tr', type: 'appStoreVersionLocalizations', attributes: { locale: 'tr', whatsNew: 'Eski' } },
  ];
  const writes: string[] = [];
  let fail = true;
  const api: AppleAPI = {
    get: async path => structuredClone(path.includes('/appStoreVersionLocalizations/') ? remote.find(r => path.endsWith(r.id))!
      : { id: 'v1', type: 'appStoreVersions', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' }, relationships: { app: { data: { id: '123', type: 'apps' } } } }),
    list: async () => ({ data: structuredClone(remote), truncated: false }),
    patch: async (_path, _type, id, attrs) => {
      if (id === 'loc-tr' && fail) { fail = false; throw new Error('Temporary outage'); }
      writes.push(id); Object.assign(remote.find(r => r.id === id)!.attributes, attrs); return {};
    },
  };
  const service = new ConnectService(f.config, f.store, () => api);
  try {
    const plan = await service.prepare({ ...f.input, localizations: [
      { locale: 'en-US', changes: { whatsNew: 'New' } }, { locale: 'tr', changes: { whatsNew: 'Yeni' } },
    ] });
    await assert.rejects(service.apply(plan.id, plan.digest), /outage/);
    assert.deepEqual(f.store.get(plan.id).completed, ['loc-en']);
    assert.equal((await service.apply(plan.id, plan.digest)).status, 'completed');
    assert.deepEqual(writes, ['loc-en', 'loc-tr']);
  } finally { f.store.close(); }
});
test('wrong version ownership and missing locales cannot create a plan', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.prepare({ ...f.input, appId: '999' }), /does not belong/);
    await assert.rejects(f.service.prepare({ ...f.input, localizations: [{ locale: 'fr-FR', changes: { whatsNew: 'New' } }] }), /does not exist/);
    assert.equal(f.patches, 0);
  } finally { f.store.close(); }
});
