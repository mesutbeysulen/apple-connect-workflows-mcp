import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as t from '../src/team-signing.js';
import { redactSecrets } from '../src/catalog.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const team = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/users': (path: string) => {
    const q = new URL(path, 'https://x').searchParams;
    const rows = [res('u-admin', 'users', { username: 'boss@x.co', roles: ['ADMIN'] }), res('u-dev', 'users', { username: 'dev@x.co', roles: ['DEVELOPER'], allAppsVisible: true }), res('u-holder', 'users', { username: 'owner@x.co', roles: ['ACCOUNT_HOLDER', 'ADMIN'] })];
    return rows.filter(r => (!q.get('filter[username]') || r.attributes.username === q.get('filter[username]')) && (!q.get('filter[roles]') || (r.attributes.roles as string[]).includes(q.get('filter[roles]')!)));
  },
  '/v1/users/u-dev': res('u-dev', 'users', { username: 'dev@x.co', roles: ['DEVELOPER'], allAppsVisible: true }),
  '/v1/users/u-admin': res('u-admin', 'users', { username: 'boss@x.co', roles: ['ADMIN'] }),
  '/v1/users/u-holder': res('u-holder', 'users', { username: 'owner@x.co', roles: ['ACCOUNT_HOLDER', 'ADMIN'] }),
  '/v1/users/u-dev/visibleApps': [],
  '/v1/userInvitations': (path: string) => new URL(path, 'https://x').searchParams.get('filter[email]') === 'pending@x.co' ? [res('inv1', 'userInvitations')] : [],
  '/v1/userInvitations/inv1': res('inv1', 'userInvitations'),
  '/v1/devices': (path: string) => {
    const udid = new URL(path, 'https://x').searchParams.get('filter[udid]');
    if (udid === null) return [res('d1', 'devices'), res('d2', 'devices')];
    return udid === '00008030-001A2B3C4D5E6F78' ? [res('d1', 'devices', { status: 'ENABLED' })] : [];
  },
  '/v1/devices/d1': res('d1', 'devices', { name: 'Old', status: 'ENABLED' }),
  '/v1/bundleIds/b1': res('b1', 'bundleIds'),
  '/v1/bundleIds/b1/bundleIdCapabilities': [res('cap-iap', 'bundleIdCapabilities', { capabilityType: 'IN_APP_PURCHASE' })],
  '/v1/certificates': [res('c-old', 'certificates', { displayName: 'Old', expirationDate: '2027-01-01' })],
  '/v1/certificates/c1': res('c1', 'certificates', { certificateType: 'IOS_DISTRIBUTION' }),
  '/v1/profiles': [],
  '/v1/profiles/p1': res('p1', 'profiles', { name: 'P', profileState: 'ACTIVE', profileContent: Buffer.from('profile-bytes').toString('base64') }),
  ...extra,
} as never, { post: (path, body) => res(`new-${path.split('/').at(-1)}`, body.data.type, body.data.type === 'certificates' ? { certificateContent: Buffer.from('DER').toString('base64'), serialNumber: 'S1' } : body.data.type === 'profiles' ? { profileContent: Buffer.from('new-profile').toString('base64') } : {}) });

test('inviting previews first, refuses existing members and the Account Holder role', async () => {
  const f = team();
  const invite = { account, email: 'new@x.co', firstName: 'N', lastName: 'M', roles: ['DEVELOPER'], appIds: ['123'] };
  assert.equal((await t.inviteUser({ ...invite, account: readOnly }, f.api)).dryRun, true);
  assert.equal(f.writes().length, 0);
  assert.equal((await t.inviteUser({ ...invite, execute: true }, f.api) as { status?: string }).status, 'invited');
  assert.equal((f.writes()[0]!.body as any).data.relationships.visibleApps.data[0].id, '123');
  assert.equal((await t.inviteUser({ ...invite, email: 'pending@x.co', execute: true }, f.api) as { status?: string }).status, 'exists');
  await assert.rejects(t.inviteUser({ ...invite, email: 'dev@x.co' }, f.api), /already on the team/);
  await assert.rejects(t.inviteUser({ ...invite, roles: ['ACCOUNT_HOLDER'] }, f.api), /ACCOUNT_HOLDER cannot be assigned/);
  await assert.rejects(t.inviteUser({ ...invite, appIds: undefined }, f.api), /--all-apps or --apps/);
  await assert.rejects(t.inviteUser({ ...invite, allAppsVisible: true }, f.api), /not both/);
  await assert.rejects(t.inviteUser({ ...invite, execute: true, account: readOnly }, f.api), /read-only/);
  assert.deepEqual(await t.cancelInvitation({ account, invitationId: 'inv1' }, f.api), { cancelled: 'inv1' });
});
test('user changes preview a diff and protect the Account Holder and the last Admin', async () => {
  const f = team();
  const preview = await t.updateUser({ account, userId: 'u-dev', roles: ['DEVELOPER', 'APP_MANAGER'], appIds: ['123'] }, f.api);
  assert.deepEqual(Object.keys(preview.changes), ['roles', 'allAppsVisible']);
  assert.deepEqual(preview.visibleApps, { from: [], to: ['123'] });
  assert.equal(f.writes().length, 0);
  await t.updateUser({ account, userId: 'u-dev', roles: ['DEVELOPER', 'APP_MANAGER'], appIds: ['123'], execute: true }, f.api);
  assert.deepEqual(f.writes().map(w => w.path), ['/v1/users/u-dev', '/v1/users/u-dev/relationships/visibleApps']);
  assert.equal((await t.updateUser({ account, userId: 'u-dev', roles: ['DEVELOPER'] }, f.api)).status, 'unchanged');
  await assert.rejects(t.updateUser({ account, userId: 'u-holder', roles: ['DEVELOPER'] }, f.api), /Account Holder cannot be changed/);
  await assert.rejects(t.removeUser({ account, userId: 'u-holder' }, f.api), /Account Holder/);
  const oneAdmin = team({ '/v1/users': (path: string) => new URL(path, 'https://x').searchParams.get('filter[roles]') === 'ADMIN' ? [res('u-admin', 'users')] : [] });
  await assert.rejects(t.removeUser({ account, userId: 'u-admin', execute: true }, oneAdmin.api), /last Admin/);
  assert.equal((await t.removeUser({ account, userId: 'u-dev' }, f.api)).dryRun, true);
  assert.equal((await t.removeUser({ account, userId: 'u-dev', execute: true }, f.api) as { status?: string }).status, 'removed');
});
test('devices register once and capabilities toggle idempotently', async () => {
  const f = team();
  assert.equal((await t.registerDevice({ account, name: 'Test iPhone', udid: '00008030-001A2B3C4D5E6F78', platform: 'IOS' }, f.api)).status, 'exists');
  assert.equal((await t.registerDevice({ account, name: 'Old iPad', udid: 'a'.repeat(40), platform: 'IOS' }, f.api)).status, 'registered');
  await assert.rejects(t.registerDevice({ account, name: 'X', udid: 'short', platform: 'IOS' }, f.api), /UDID/);
  assert.deepEqual((await t.updateDevice({ account, deviceId: 'd1', status: 'DISABLED' }, f.api) as { changed?: string[] }).changed, ['status']);
  assert.equal((await t.setCapability({ account, bundleId: 'b1', capability: 'IN_APP_PURCHASE', enabled: true }, f.api)).status, 'unchanged');
  assert.equal((await t.setCapability({ account, bundleId: 'b1', capability: 'PUSH_NOTIFICATIONS', enabled: true }, f.api)).status, 'enabled');
  assert.equal((await t.setCapability({ account, bundleId: 'b1', capability: 'IN_APP_PURCHASE', enabled: false }, f.api)).status, 'disabled');
  assert.equal((await t.setCapability({ account, bundleId: 'b1', capability: 'HEALTHKIT', enabled: false }, f.api)).status, 'unchanged');
  await assert.rejects(t.setCapability({ account, bundleId: 'b1', capability: 'TELEPORT', enabled: true }, f.api), /Capability must be/);
  await assert.rejects(t.registerDevice({ account: readOnly, name: 'X', udid: 'a'.repeat(40), platform: 'IOS' }, f.api), /read-only/);
});
test('certificates use only the CSR, write the issued certificate and revoke only on execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-')); const csr = join(dir, 'req.certSigningRequest'); const out = join(dir, 'cert.cer');
  writeFileSync(csr, '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----\n');
  const f = team();
  try {
    const preview = await t.createCertificate({ account, type: 'IOS_DISTRIBUTION', csrPath: csr, out }, f.api);
    assert.equal(preview.dryRun, true); assert.equal(preview.existing.length, 1); assert.equal(f.writes().length, 0);
    const issued = await t.createCertificate({ account, type: 'IOS_DISTRIBUTION', csrPath: csr, out, execute: true }, f.api);
    assert.equal(readFileSync(out, 'utf8'), 'DER');
    assert(!JSON.stringify(issued).includes(Buffer.from('DER').toString('base64')));
    writeFileSync(csr, '-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n');
    await assert.rejects(t.createCertificate({ account, type: 'IOS_DISTRIBUTION', csrPath: csr, out }, f.api), /private key/);
    writeFileSync(csr, 'garbage');
    await assert.rejects(t.createCertificate({ account, type: 'IOS_DISTRIBUTION', csrPath: csr, out }, f.api), /not a PEM/);
    await assert.rejects(t.createCertificate({ account, type: 'SOMETHING', csrPath: csr, out }, f.api), /Certificate type/);
    assert.equal((await t.revokeCertificate({ account, certificateId: 'c1' }, f.api)).dryRun, true);
    const before = f.writes().length;
    assert.equal((await t.revokeCertificate({ account, certificateId: 'c1', execute: true }, f.api) as { status?: string }).status, 'revoked');
    assert.equal(f.writes().length, before + 1);
  } finally { rmSync(dir, { recursive: true }); }
});
test('profiles are created with the right devices, saved privately and reused by name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-'));
  const f = team();
  const base = { account, name: 'App Store', bundleId: 'b1', certificateIds: ['c1'] };
  try {
    const store = await t.createProfile({ ...base, type: 'IOS_APP_STORE', out: join(dir, 'store.mobileprovision') }, f.api);
    assert.equal(store.status, 'created');
    assert.equal((f.writes()[0]!.body as any).data.relationships.devices, undefined);
    assert.equal(readFileSync(join(dir, 'store.mobileprovision'), 'utf8'), 'new-profile');
    assert.equal(statSync(join(dir, 'store.mobileprovision')).mode & 0o777, 0o600);
    await t.createProfile({ ...base, name: 'Dev', type: 'IOS_APP_DEVELOPMENT', deviceIds: 'all', out: join(dir, 'dev.mobileprovision') }, f.api);
    assert.deepEqual((f.writes()[1]!.body as any).data.relationships.devices.data.map((d: any) => d.id), ['d1', 'd2']);
    await assert.rejects(t.createProfile({ ...base, type: 'IOS_APP_DEVELOPMENT', out: join(dir, 'x') }, f.api), /need --devices/);
    await assert.rejects(t.createProfile({ ...base, type: 'IOS_APP_STORE', deviceIds: ['d1'], out: join(dir, 'x') }, f.api), /take no devices/);
    const reused = team({ '/v1/profiles': [res('p1', 'profiles', { name: 'App Store', profileState: 'ACTIVE', profileContent: Buffer.from('existing').toString('base64') })] });
    assert.equal((await t.createProfile({ ...base, type: 'IOS_APP_STORE', out: join(dir, 'again.mobileprovision') }, reused.api)).status, 'exists');
    assert.equal(reused.writes().length, 0);
    assert.equal((await t.downloadProfile({ profileId: 'p1', out: join(dir, 'p1.mobileprovision') }, f.api)).name, 'P');
    assert.deepEqual(await t.deleteProfile({ account, profileId: 'p1' }, f.api), { removed: 'p1' });
  } finally { rmSync(dir, { recursive: true }); }
});
test('certificate and profile contents never reach the model', () => {
  const text = JSON.stringify(redactSecrets({ data: [{ attributes: { certificateContent: 'AAA', profileContent: 'BBB', name: 'kept' } }] }));
  assert(!text.includes('AAA') && !text.includes('BBB') && text.includes('kept'));
});
