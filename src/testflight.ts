import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import { validId } from './apple-rules.js';

export interface TestFlightAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
}
export async function distributeBuild(
  input: { account: Account; appId: string; buildId: string; groupId: string },
  api: TestFlightAPI,
): Promise<{ status: 'already_assigned' | 'submitted'; buildId: string; groupId: string }> {
  const { account, appId, buildId, groupId } = input;
  requireWrite(account, appId);
  if (![appId, buildId, groupId].every(validId)) throw new Error('Invalid app, build or group ID.');
  const [buildApp, groupApp, build, group] = await Promise.all([
    api.get(`/v1/builds/${buildId}/app`), api.get(`/v1/betaGroups/${groupId}/app`),
    api.get(`/v1/builds/${buildId}`), api.get(`/v1/betaGroups/${groupId}`),
  ]);
  if (buildApp.id !== appId || groupApp.id !== appId) throw new Error('Build and beta group must belong to the selected app.');
  if (build.attributes.expired === true || build.attributes.processingState !== 'VALID') throw new Error(`Build is not ready for TestFlight: ${build.attributes.processingState ?? 'unknown'}.`);
  if (group.attributes.isInternalGroup === false && build.attributes.buildAudienceType === 'INTERNAL_ONLY') throw new Error('Internal-only build cannot be assigned to an external group.');
  const assigned = await api.list(`/v1/betaGroups/${groupId}/builds?limit=200`, 2000);
  if (assigned.truncated) throw new Error('Incomplete group build list; refusing an uncertain duplicate association.');
  if (assigned.data.some(row => row.id === buildId)) return { status: 'already_assigned', buildId, groupId };
  await api.request('POST', `/v1/betaGroups/${groupId}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
  return { status: 'submitted', buildId, groupId };
}
export type GroupOutcome = { groupId: string; status: 'already_assigned' | 'submitted' | 'failed'; error?: string };
/** Assigns one build to several groups independently; one failing group does not block the others. */
export async function distributeToGroups(input: { account: Account; appId: string; buildId: string; groupIds: string[] }, api: TestFlightAPI): Promise<{ buildId: string; groups: GroupOutcome[]; ok: boolean }> {
  const { groupIds, ...rest } = input;
  requireWrite(rest.account, rest.appId);
  if (!groupIds.length || groupIds.length > 50 || new Set(groupIds).size !== groupIds.length) throw new Error('Provide 1-50 distinct beta group IDs.');
  const groups: GroupOutcome[] = [];
  for (const groupId of groupIds) {
    try { groups.push({ groupId, status: (await distributeBuild({ ...rest, groupId }, api)).status }); }
    catch (error) { groups.push({ groupId, status: 'failed', error: error instanceof Error ? error.message : 'Assignment failed' }); }
  }
  return { buildId: rest.buildId, groups, ok: groups.every(g => g.status !== 'failed') };
}
