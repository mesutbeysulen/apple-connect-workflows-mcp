import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { requireAccountWrite, type Account } from './config.js';
import type { Method, Resource } from './apple.js';
import { validId } from './apple-rules.js';

export interface TeamAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<void>;
}
const needIds = (...ids: string[]) => { if (!ids.every(validId)) throw new Error('Invalid ID.'); };
const clean = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
async function all(api: Pick<TeamAPI, 'list'>, path: string): Promise<Resource[]> {
  const rows = await api.list(path, 2000);
  if (rows.truncated) throw new Error(`Incomplete list at ${path.split('?')[0]}; refusing to continue.`);
  return rows.data;
}
async function writeOut(path: string, data: Buffer | string, mode = 0o600): Promise<void> {
  if (!isAbsolute(path)) throw new Error('--out must be an absolute path.');
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try { await writeFile(temporary, data, { mode, flag: 'wx' }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

// ---- Team members ----
/** Roles an API key may grant. Account Holder cannot be assigned, and Admin can only be given knowingly. */
export const ASSIGNABLE_ROLES = ['ADMIN', 'FINANCE', 'SALES', 'MARKETING', 'APP_MANAGER', 'DEVELOPER', 'ACCESS_TO_REPORTS', 'CUSTOMER_SUPPORT', 'CREATE_APPS', 'CLOUD_MANAGED_DEVELOPER_ID', 'CLOUD_MANAGED_APP_DISTRIBUTION', 'GENERATE_INDIVIDUAL_KEYS'];
function checkRoles(roles: string[]): void {
  if (!roles.length || new Set(roles).size !== roles.length || !roles.every(r => ASSIGNABLE_ROLES.includes(r))) throw new Error(`Roles must be distinct values from ${ASSIGNABLE_ROLES.join(', ')}. ACCOUNT_HOLDER cannot be assigned.`);
}
export interface Access { roles?: string[]; allAppsVisible?: boolean; appIds?: string[]; provisioningAllowed?: boolean }
function checkAccess(access: Access): void {
  if (access.roles) checkRoles(access.roles);
  if (access.appIds && (access.allAppsVisible || !access.appIds.every(id => /^\d+$/.test(id)))) throw new Error('Use --apps with numeric app IDs, or --all-apps, not both.');
}
/** Invites a person to the team; Apple emails them. Previews unless execute. */
export async function inviteUser(input: { account: Account; email: string; firstName: string; lastName: string; execute?: boolean } & Access, api: TeamAPI) {
  const { account, email, firstName, lastName, execute = false, ...access } = input;
  if (execute) requireAccountWrite(account);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !firstName.trim() || !lastName.trim()) throw new Error('Provide a valid email, first name and last name.');
  if (!access.roles) throw new Error('--roles is required.');
  checkAccess(access);
  if (!access.allAppsVisible && !access.appIds?.length) throw new Error('Choose --all-apps or --apps so the person can see something.');
  const member = (await all(api, `/v1/users?${new URLSearchParams({ 'filter[username]': email, limit: '10' })}`))[0];
  if (member) throw new Error(`${email} is already on the team (user ${member.id}). Use user-update instead.`);
  const pending = (await all(api, `/v1/userInvitations?${new URLSearchParams({ 'filter[email]': email, limit: '10' })}`))[0];
  const preview = { dryRun: !execute, email, firstName, lastName, roles: access.roles, allAppsVisible: access.allAppsVisible ?? false, appIds: access.appIds ?? [], provisioningAllowed: access.provisioningAllowed ?? false,
    effect: 'Apple emails this person an invitation to the team with these roles.' };
  if (pending) return { ...preview, status: 'exists' as const, invitationId: pending.id };
  if (!execute) return preview;
  const created = await api.post('/v1/userInvitations', { data: { type: 'userInvitations',
    attributes: clean({ email, firstName, lastName, roles: access.roles, allAppsVisible: access.allAppsVisible, provisioningAllowed: access.provisioningAllowed }),
    ...(access.appIds?.length ? { relationships: { visibleApps: { data: access.appIds.map(id => ({ type: 'apps', id })) } } } : {}) } });
  return { ...preview, status: 'invited' as const, invitationId: created.id };
}
export async function cancelInvitation(input: { account: Account; invitationId: string }, api: TeamAPI) {
  const { account, invitationId } = input;
  requireAccountWrite(account); needIds(invitationId);
  await api.get(`/v1/userInvitations/${invitationId}`);
  await api.delete(`/v1/userInvitations/${invitationId}`);
  return { cancelled: invitationId };
}
async function teamUser(api: TeamAPI, userId: string): Promise<Resource> {
  needIds(userId);
  const user = await api.get(`/v1/users/${userId}`);
  if ((user.attributes.roles as string[] | undefined)?.includes('ACCOUNT_HOLDER')) throw new Error('The Account Holder cannot be changed or removed through the API.');
  return user;
}
/** Changes roles and app access. Previews the difference unless execute. */
export async function updateUser(input: { account: Account; userId: string; execute?: boolean } & Access, api: TeamAPI) {
  const { account, userId, execute = false, ...access } = input;
  if (execute) requireAccountWrite(account);
  checkAccess(access);
  const user = await teamUser(api, userId);
  const attributes = clean({ roles: access.roles, allAppsVisible: access.appIds?.length ? false : access.allAppsVisible, provisioningAllowed: access.provisioningAllowed });
  const changes = Object.fromEntries(Object.entries(attributes).filter(([key, value]) => JSON.stringify(user.attributes[key]) !== JSON.stringify(value)));
  const currentApps = access.appIds ? (await all(api, `/v1/users/${userId}/visibleApps?limit=200`)).map(row => row.id) : [];
  const appsChange = access.appIds && (currentApps.length !== access.appIds.length || !access.appIds.every(id => currentApps.includes(id)));
  const preview = { dryRun: !execute, userId, username: user.attributes.username, changes, visibleApps: appsChange ? { from: currentApps, to: access.appIds } : undefined };
  if (!Object.keys(changes).length && !appsChange) return { ...preview, status: 'unchanged' as const };
  if (!execute) return preview;
  if (Object.keys(changes).length) await api.patch(`/v1/users/${userId}`, 'users', userId, changes);
  if (appsChange) await api.request('PATCH', `/v1/users/${userId}/relationships/visibleApps`, { data: access.appIds!.map(id => ({ type: 'apps', id })) });
  return { ...preview, status: 'updated' as const };
}
/** Removes a person from the team. Cannot be undone; previews unless execute. */
export async function removeUser(input: { account: Account; userId: string; execute?: boolean }, api: TeamAPI) {
  const { account, userId, execute = false } = input;
  if (execute) requireAccountWrite(account);
  const user = await teamUser(api, userId);
  const roles = (user.attributes.roles as string[] | undefined) ?? [];
  if (roles.includes('ADMIN')) {
    const admins = await all(api, `/v1/users?${new URLSearchParams({ 'filter[roles]': 'ADMIN', limit: '200' })}`);
    if (admins.filter(row => row.id !== userId).length === 0) throw new Error('Refusing to remove the last Admin.');
  }
  const preview = { dryRun: !execute, userId, username: user.attributes.username, roles, effect: 'Removes this person from the team. This cannot be undone; they would need a new invitation.' };
  if (!execute) return preview;
  await api.delete(`/v1/users/${userId}`);
  return { ...preview, status: 'removed' as const };
}

// ---- Devices ----
/** iPhone/iPad UDIDs are 25 or 40 characters; Mac provisioning UDIDs use the 8-4-4-4-12 form. */
export const validUdid = (udid: string) => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/.test(udid) || /^[0-9A-Fa-f]{40}$/.test(udid) || /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(udid);
export async function registerDevice(input: { account: Account; name: string; udid: string; platform: string }, api: TeamAPI) {
  const { account, name, udid, platform } = input;
  requireAccountWrite(account);
  if (!name.trim() || name.length > 50) throw new Error('Device name must be 1-50 characters.');
  if (!validUdid(udid)) throw new Error('UDID must be a 25 or 40 character device identifier, or a Mac provisioning UDID.');
  if (!['IOS', 'MAC_OS'].includes(platform)) throw new Error('Platform must be IOS or MAC_OS.');
  const found = (await all(api, `/v1/devices?${new URLSearchParams({ 'filter[udid]': udid, limit: '10' })}`))[0];
  if (found) return { status: 'exists' as const, deviceId: found.id, deviceStatus: found.attributes.status };
  return { status: 'registered' as const, deviceId: (await api.post('/v1/devices', { data: { type: 'devices', attributes: { name, udid, platform } } })).id };
}
export async function updateDevice(input: { account: Account; deviceId: string; name?: string; status?: string }, api: TeamAPI) {
  const { account, deviceId, name, status } = input;
  requireAccountWrite(account); needIds(deviceId);
  if (status !== undefined && !['ENABLED', 'DISABLED'].includes(status)) throw new Error('Status must be ENABLED or DISABLED.');
  const device = await api.get(`/v1/devices/${deviceId}`);
  const changes = Object.fromEntries(Object.entries(clean({ name, status })).filter(([key, value]) => device.attributes[key] !== value));
  if (!Object.keys(changes).length) return { status: 'unchanged' as const, deviceId };
  await api.patch(`/v1/devices/${deviceId}`, 'devices', deviceId, changes);
  return { status: 'updated' as const, deviceId, changed: Object.keys(changes) };
}

// ---- Bundle ID capabilities ----
export const CAPABILITIES = ['ICLOUD', 'IN_APP_PURCHASE', 'GAME_CENTER', 'PUSH_NOTIFICATIONS', 'WALLET', 'INTER_APP_AUDIO', 'MAPS', 'ASSOCIATED_DOMAINS', 'PERSONAL_VPN', 'APP_GROUPS', 'HEALTHKIT', 'HOMEKIT',
  'WIRELESS_ACCESSORY_CONFIGURATION', 'APPLE_PAY', 'DATA_PROTECTION', 'SIRIKIT', 'NETWORK_EXTENSIONS', 'MULTIPATH', 'HOT_SPOT', 'NFC_TAG_READING', 'CLASSKIT', 'AUTOFILL_CREDENTIAL_PROVIDER',
  'ACCESS_WIFI_INFORMATION', 'NETWORK_CUSTOM_PROTOCOL', 'COREMEDIA_HLS_LOW_LATENCY', 'SYSTEM_EXTENSION_INSTALL', 'USER_MANAGEMENT', 'APPLE_ID_AUTH'];
/** Turns a capability on or off for an App ID. Capabilities that need settings are done with api_write_plan. */
export async function setCapability(input: { account: Account; bundleId: string; capability: string; enabled: boolean }, api: TeamAPI) {
  const { account, bundleId, capability, enabled } = input;
  requireAccountWrite(account); needIds(bundleId);
  if (!CAPABILITIES.includes(capability)) throw new Error(`Capability must be one of ${CAPABILITIES.join(', ')}.`);
  await api.get(`/v1/bundleIds/${bundleId}`);
  const current = (await all(api, `/v1/bundleIds/${bundleId}/bundleIdCapabilities?limit=200`)).find(row => row.attributes.capabilityType === capability);
  if (enabled) {
    if (current) return { status: 'unchanged' as const, capabilityId: current.id };
    return { status: 'enabled' as const, capabilityId: (await api.post('/v1/bundleIdCapabilities', { data: { type: 'bundleIdCapabilities', attributes: { capabilityType: capability }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundleId } } } } })).id };
  }
  if (!current) return { status: 'unchanged' as const, capabilityId: null };
  await api.delete(`/v1/bundleIdCapabilities/${current.id}`);
  return { status: 'disabled' as const, capabilityId: current.id };
}

// ---- Certificates ----
export const CERTIFICATE_TYPES = ['DEVELOPMENT', 'DISTRIBUTION', 'IOS_DEVELOPMENT', 'IOS_DISTRIBUTION', 'MAC_APP_DEVELOPMENT', 'MAC_APP_DISTRIBUTION', 'MAC_INSTALLER_DISTRIBUTION', 'DEVELOPER_ID_APPLICATION', 'DEVELOPER_ID_APPLICATION_G2', 'DEVELOPER_ID_KEXT', 'DEVELOPER_ID_KEXT_G2', 'PASS_TYPE_ID', 'PASS_TYPE_ID_WITH_NFC', 'APPLE_PAY', 'APPLE_PAY_MERCHANT_IDENTITY', 'APPLE_PAY_PSP_IDENTITY', 'APPLE_PAY_RSA', 'IDENTITY_ACCESS'];
/**
 * Issues a certificate from a certificate signing request made on your Mac. The private key never leaves your
 * machine; only the CSR is sent. The issued certificate is written as a DER .cer file. Previews unless execute.
 */
export async function createCertificate(input: { account: Account; type: string; csrPath: string; out: string; execute?: boolean }, api: TeamAPI) {
  const { account, type, csrPath, out, execute = false } = input;
  if (execute) requireAccountWrite(account);
  if (!CERTIFICATE_TYPES.includes(type)) throw new Error(`Certificate type must be one of ${CERTIFICATE_TYPES.join(', ')}.`);
  if (!isAbsolute(csrPath) || !isAbsolute(out)) throw new Error('--csr and --out must be absolute paths.');
  const csr = (await readFile(csrPath, 'utf8')).trim();
  if (/PRIVATE KEY/.test(csr)) throw new Error('This file contains a private key. Pass the certificate signing request (.certSigningRequest), never the key.');
  if (!/^-----BEGIN (NEW )?CERTIFICATE REQUEST-----[\s\S]+-----END (NEW )?CERTIFICATE REQUEST-----$/.test(csr)) throw new Error('File is not a PEM certificate signing request.');
  const existing = (await all(api, `/v1/certificates?${new URLSearchParams({ 'filter[certificateType]': type, limit: '200' })}`)).map(row => ({ id: row.id, name: row.attributes.displayName ?? row.attributes.name, expires: row.attributes.expirationDate }));
  const preview = { dryRun: !execute, type, out, existing, effect: 'Issues a new certificate. Apple limits how many of some types a team may hold.' };
  if (!execute) return preview;
  const created = await api.post('/v1/certificates', { data: { type: 'certificates', attributes: { csrContent: csr, certificateType: type } } });
  const content = created.attributes.certificateContent;
  if (typeof content !== 'string' || !content) throw new Error(`Certificate ${created.id} was issued but Apple returned no content; download it from the developer website.`);
  await writeOut(out, Buffer.from(content, 'base64'), 0o644);
  return { ...preview, status: 'issued' as const, certificateId: created.id, serialNumber: created.attributes.serialNumber, expires: created.attributes.expirationDate };
}
/** Revokes a certificate. Builds and profiles signed with it stop working; cannot be undone. Previews unless execute. */
export async function revokeCertificate(input: { account: Account; certificateId: string; execute?: boolean }, api: TeamAPI) {
  const { account, certificateId, execute = false } = input;
  if (execute) requireAccountWrite(account);
  needIds(certificateId);
  const certificate = await api.get(`/v1/certificates/${certificateId}`);
  const preview = { dryRun: !execute, certificateId, type: certificate.attributes.certificateType, name: certificate.attributes.displayName ?? certificate.attributes.name, expires: certificate.attributes.expirationDate,
    effect: 'Revokes this certificate. Profiles that include it become invalid. This cannot be undone.' };
  if (!execute) return preview;
  await api.delete(`/v1/certificates/${certificateId}`);
  return { ...preview, status: 'revoked' as const };
}

// ---- Provisioning profiles ----
export const PROFILE_TYPES = ['IOS_APP_DEVELOPMENT', 'IOS_APP_STORE', 'IOS_APP_ADHOC', 'IOS_APP_INHOUSE', 'MAC_APP_DEVELOPMENT', 'MAC_APP_STORE', 'MAC_APP_DIRECT', 'TVOS_APP_DEVELOPMENT', 'TVOS_APP_STORE', 'TVOS_APP_ADHOC', 'TVOS_APP_INHOUSE', 'MAC_CATALYST_APP_DEVELOPMENT', 'MAC_CATALYST_APP_STORE', 'MAC_CATALYST_APP_DIRECT'];
const NEEDS_DEVICES = /DEVELOPMENT|ADHOC/;
async function saveProfile(profile: Resource, out: string): Promise<void> {
  const content = profile.attributes.profileContent;
  if (typeof content !== 'string' || !content) throw new Error(`Profile ${profile.id} has no downloadable content.`);
  await writeOut(out, Buffer.from(content, 'base64'));
}
/** Creates a provisioning profile and saves it, or saves the existing active one with the same name. */
export async function createProfile(input: { account: Account; name: string; type: string; bundleId: string; certificateIds: string[]; deviceIds?: string[] | 'all'; out: string }, api: TeamAPI) {
  const { account, name, type, bundleId, certificateIds, out } = input;
  requireAccountWrite(account);
  if (!name.trim() || name.length > 100) throw new Error('Profile name must be 1-100 characters.');
  if (!PROFILE_TYPES.includes(type)) throw new Error(`Profile type must be one of ${PROFILE_TYPES.join(', ')}.`);
  if (!certificateIds.length) throw new Error('Provide at least one certificate.');
  needIds(bundleId, ...certificateIds);
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
  const devicesNeeded = NEEDS_DEVICES.test(type);
  if (devicesNeeded !== (input.deviceIds !== undefined)) throw new Error(devicesNeeded ? 'Development and ad hoc profiles need --devices or --all-devices.' : 'App Store profiles take no devices.');
  await api.get(`/v1/bundleIds/${bundleId}`);
  const existing = (await all(api, `/v1/profiles?${new URLSearchParams({ 'filter[name]': name, limit: '10' })}`)).find(row => row.attributes.name === name && row.attributes.profileState === 'ACTIVE');
  if (existing) { await saveProfile(existing, out); return { status: 'exists' as const, profileId: existing.id, out }; }
  const deviceIds = input.deviceIds === 'all'
    ? (await all(api, `/v1/devices?${new URLSearchParams({ 'filter[status]': 'ENABLED', limit: '200' })}`)).map(row => row.id)
    : input.deviceIds ?? [];
  if (devicesNeeded && !deviceIds.length) throw new Error('No enabled devices to include.');
  needIds(...deviceIds);
  const created = await api.post('/v1/profiles', { data: { type: 'profiles', attributes: { name, profileType: type }, relationships: {
    bundleId: { data: { type: 'bundleIds', id: bundleId } }, certificates: { data: certificateIds.map(id => ({ type: 'certificates', id })) },
    ...(deviceIds.length ? { devices: { data: deviceIds.map(id => ({ type: 'devices', id })) } } : {}) } } });
  await saveProfile(created, out);
  return { status: 'created' as const, profileId: created.id, devices: deviceIds.length, expires: created.attributes.expirationDate, out };
}
export async function downloadProfile(input: { profileId: string; out: string }, api: Pick<TeamAPI, 'get'>) {
  needIds(input.profileId);
  const profile = await api.get(`/v1/profiles/${input.profileId}`);
  await saveProfile(profile, input.out);
  return { profileId: profile.id, name: profile.attributes.name, state: profile.attributes.profileState, expires: profile.attributes.expirationDate, out: input.out };
}
export async function deleteProfile(input: { account: Account; profileId: string }, api: TeamAPI) {
  const { account, profileId } = input;
  requireAccountWrite(account); needIds(profileId);
  await api.get(`/v1/profiles/${profileId}`);
  await api.delete(`/v1/profiles/${profileId}`);
  return { removed: profileId };
}
