import test from 'node:test';
import assert from 'node:assert/strict';
import { distributeBuild, type TestFlightAPI } from '../src/testflight.js';
import type { Account } from '../src/config.js';
const account: Account = { name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] };
function fixture() {
  let processingState = 'VALID'; let groupApp = '123'; let existing = false; let calls = 0;
  const api: TestFlightAPI = {
    get: async path => ({ id: path.endsWith('/app') ? (path.includes('betaGroups') ? groupApp : '123') : 'resource', type: 'resource',
      attributes: path.includes('/builds/') ? { processingState, expired: false, buildAudienceType: 'APP_STORE_ELIGIBLE' } : { isInternalGroup: true } }),
    list: async () => ({ data: existing ? [{ id: 'build-1', type: 'builds', attributes: {} }] : [], truncated: false }),
    request: async (_method, _path, body) => { calls++; assert.deepEqual(body, { data: [{ type: 'builds', id: 'build-1' }] }); return {}; },
  };
  return { api, get calls() { return calls; }, setState: (s: string) => processingState = s, setGroupApp: (s: string) => groupApp = s, setExisting: () => existing = true };
}
test('distributes a ready build to a group in the same app', async () => {
  const f = fixture();
  assert.deepEqual(await distributeBuild({ account, appId: '123', buildId: 'build-1', groupId: 'group-1' }, f.api), { status: 'submitted', buildId: 'build-1', groupId: 'group-1' });
  assert.equal(f.calls, 1);
});
test('already assigned build is returned without another write', async () => {
  const f = fixture(); f.setExisting();
  assert.equal((await distributeBuild({ account, appId: '123', buildId: 'build-1', groupId: 'group-1' }, f.api)).status, 'already_assigned');
  assert.equal(f.calls, 0);
});
test('rejects wrong app, unprocessed build and read-only account before association', async () => {
  const f = fixture(); f.setGroupApp('other');
  await assert.rejects(distributeBuild({ account, appId: '123', buildId: 'build-1', groupId: 'group-1' }, f.api), /selected app/);
  f.setGroupApp('123'); f.setState('PROCESSING');
  await assert.rejects(distributeBuild({ account, appId: '123', buildId: 'build-1', groupId: 'group-1' }, f.api), /not ready/);
  await assert.rejects(distributeBuild({ account: { ...account, readOnly: true }, appId: '123', buildId: 'build-1', groupId: 'group-1' }, f.api), /read-only/);
  assert.equal(f.calls, 0);
});
