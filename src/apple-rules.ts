import type { Resource } from './apple.js';

/** Shared local validation rules for App Store Connect identifiers and states. */
export const validId = (id: string) => /^[A-Za-z0-9-]{1,128}$/.test(id);
export const PLACEMENT_GROUP_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const validGroup = (group: string) => PLACEMENT_GROUP_PATTERN.test(group);
export const EDITABLE_VERSION_STATES = ['PREPARE_FOR_SUBMISSION', 'INVALID_BINARY', 'REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED'];
/** Apple has no /appStoreVersions/{id}/app endpoint, so ownership comes from the version's own app link. */
export async function versionOfApp(api: { get(path: string): Promise<Resource> }, appId: string, versionId: string): Promise<Resource> {
  const version = await api.get(`/v1/appStoreVersions/${versionId}?include=app`);
  const link = version?.relationships?.app?.data;
  if (!link || Array.isArray(link) || link.id !== appId) throw new Error('Version does not belong to the requested app.');
  return version;
}
