import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import { submitForReview, type ReviewAPI, type ReviewResult } from './review.js';
import { EDITABLE_VERSION_STATES } from './screenshots.js';

export interface ReadinessAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
}
export interface ReadinessReport {
  ready: boolean; appId: string; versionId: string; versionString: string; state: string;
  blockers: string[]; warnings: string[]; notChecked: string[];
}
const blank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());
/** Returns undefined when Apple has no such related resource yet. */
async function optional(api: ReadinessAPI, path: string): Promise<Resource | undefined> {
  try { return (await api.get(path)) ?? undefined; }
  catch (error) { if (error instanceof AppleError && error.status === 404) return undefined; throw error; }
}
const NOT_CHECKABLE = [
  'App Privacy labels (not readable through this API flow)',
  'Screenshot coverage for each required device size',
  'App Review guideline compliance and final Apple validation',
];
/** Read-only pre-submission report. It lists what is locally verifiable; Apple's own validation still decides. */
export async function releaseReadiness(api: ReadinessAPI, appId: string, versionId: string): Promise<ReadinessReport> {
  if (![appId, versionId].every(id => /^[A-Za-z0-9-]{1,128}$/.test(id))) throw new Error('Invalid app or version ID.');
  if ((await api.get(`/v1/appStoreVersions/${versionId}/app`)).id !== appId) throw new Error('Version does not belong to the requested app.');
  const blockers: string[] = [];
  const warnings: string[] = [];
  const version = await api.get(`/v1/appStoreVersions/${versionId}`);
  const state = String(version.attributes.appVersionState ?? version.attributes.appStoreState ?? 'UNKNOWN');
  const versionString = String(version.attributes.versionString ?? '');
  if (!EDITABLE_VERSION_STATES.includes(String(version.attributes.appStoreState ?? state))) blockers.push(`Version state ${state} cannot be submitted.`);
  if (blank(version.attributes.copyright)) blockers.push('Version copyright is empty.');

  const build = await optional(api, `/v1/appStoreVersions/${versionId}/build`);
  if (!build) blockers.push('No build is attached to this version.');
  else {
    if (build.attributes.processingState !== 'VALID') blockers.push(`Attached build is not VALID: ${build.attributes.processingState ?? 'unknown'}.`);
    if (build.attributes.expired === true) blockers.push('Attached build has expired.');
    if (build.attributes.usesNonExemptEncryption === null || build.attributes.usesNonExemptEncryption === undefined) blockers.push('Attached build has no export compliance answer (usesNonExemptEncryption).');
  }

  const versions = await api.list(`/v1/apps/${appId}/appStoreVersions?limit=200`, 2000);
  const released = versions.data.some(row => row.id !== versionId && ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(String(row.attributes.appVersionState ?? row.attributes.appStoreState)));
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (localizations.truncated) warnings.push('Localization list is truncated; some locales were not checked.');
  if (!localizations.data.length) blockers.push('Version has no localizations.');
  for (const localization of localizations.data) {
    const locale = String(localization.attributes.locale ?? localization.id);
    for (const [field, label] of [['description', 'description'], ['keywords', 'keywords'], ['supportUrl', 'support URL']] as const) {
      if (blank(localization.attributes[field])) blockers.push(`${locale}: ${label} is empty.`);
    }
    if (released && blank(localization.attributes.whatsNew)) blockers.push(`${locale}: release notes are empty on an update.`);
    let shots = 0;
    const placements = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/placements?${new URLSearchParams({ 'filter[placementType]': 'APP_SCREENSHOT', limit: '200' })}`, 200);
    shots += placements.data.length;
    for (const placement of placements.data) if (placement.attributes.state === 'FAILED') warnings.push(`${locale}: screenshot placement ${placement.id} failed processing.`);
    const sets = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=200`, 200);
    for (const set of sets.data) {
      if (shots) break;
      shots += (await api.list(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=1`, 1)).data.length;
    }
    if (!shots) blockers.push(`${locale}: no screenshots.`);
    for (const placementType of ['PRODUCT_PAGE_HEADER_ASSET', 'APP_STORE_SEARCH_RESULTS_ASSET']) {
      const creative = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/placements?${new URLSearchParams({ 'filter[placementType]': placementType, limit: '50' })}`, 50);
      for (const placement of creative.data) if (placement.attributes.state === 'FAILED') warnings.push(`${locale}: ${placementType} placement ${placement.id} failed processing.`);
    }
  }

  const review = await optional(api, `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (!review) blockers.push('App Review contact details are missing.');
  else for (const field of ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail']) if (blank(review.attributes[field])) blockers.push(`App Review detail ${field} is empty.`);

  const app = await api.get(`/v1/apps/${appId}`);
  if (blank(app.attributes.contentRightsDeclaration)) blockers.push('Content rights declaration is not set.');
  const infos = await api.list(`/v1/apps/${appId}/appInfos?limit=50`, 50);
  const info = infos.data.find(row => EDITABLE_VERSION_STATES.includes(String(row.attributes.appStoreState ?? row.attributes.state))) ?? infos.data[0];
  if (!info) blockers.push('App information is unavailable.');
  else {
    if (!await optional(api, `/v1/appInfos/${info.id}/primaryCategory`)) blockers.push('Primary category is not set.');
    const rating = await optional(api, `/v1/appInfos/${info.id}/ageRatingDeclaration`);
    if (!rating || Object.values(rating.attributes).every(blank)) blockers.push('Age rating questionnaire is not answered.');
    const infoLocalizations = await api.list(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`, 2000);
    for (const row of infoLocalizations.data) {
      const locale = String(row.attributes.locale ?? row.id);
      if (blank(row.attributes.name)) blockers.push(`${locale}: app name is empty.`);
      if (blank(row.attributes.privacyPolicyUrl)) blockers.push(`${locale}: privacy policy URL is empty.`);
    }
  }
  if (!await optional(api, `/v1/apps/${appId}/appPriceSchedule`)) blockers.push('App price schedule is not set.');
  if (!await optional(api, `/v1/apps/${appId}/appAvailabilityV2`)) warnings.push('App availability could not be read.');
  return { ready: !blockers.length, appId, versionId, versionString, state, blockers, warnings, notChecked: NOT_CHECKABLE };
}
function confirmVersion(version: Resource, typed: string): void {
  if (version.attributes.versionString !== typed) throw new Error(`--version-string ${typed} does not match this version (${version.attributes.versionString}).`);
}
/** Submits a version only when the readiness report has no blockers and the operator typed its version string. */
export async function submitRelease(input: { account: Account; appId: string; versionId: string; versionString: string }, api: ReadinessAPI & ReviewAPI): Promise<ReviewResult & { warnings: string[] }> {
  const { account, appId, versionId, versionString } = input;
  requireWrite(account, appId);
  const report = await releaseReadiness(api, appId, versionId);
  const version = await api.get(`/v1/appStoreVersions/${versionId}`);
  confirmVersion(version, versionString);
  if (!report.ready) throw new Error(`Release is not ready:\n- ${report.blockers.join('\n- ')}`);
  const result = await submitForReview({ account, appId, platform: String(version.attributes.platform ?? 'IOS'), items: [{ relation: 'appStoreVersion', id: versionId }] }, api);
  return { ...result, warnings: report.warnings };
}
/** Releases an approved version that is waiting for the developer. This cannot be undone. */
export async function publishRelease(input: { account: Account; appId: string; versionId: string; versionString: string }, api: ReadinessAPI & Pick<ReviewAPI, 'post'>): Promise<{ status: 'released' | 'already_released'; state: string }> {
  const { account, appId, versionId, versionString } = input;
  requireWrite(account, appId);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(versionId)) throw new Error('Invalid version ID.');
  if ((await api.get(`/v1/appStoreVersions/${versionId}/app`)).id !== appId) throw new Error('Version does not belong to the requested app.');
  const version = await api.get(`/v1/appStoreVersions/${versionId}`);
  confirmVersion(version, versionString);
  const stateOf = (r: Resource) => String(r.attributes.appVersionState ?? r.attributes.appStoreState ?? 'UNKNOWN');
  const state = stateOf(version);
  if (['PROCESSING_FOR_DISTRIBUTION', 'PROCESSING_FOR_APP_STORE', 'READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'].includes(state)) return { status: 'already_released', state };
  if (state !== 'PENDING_DEVELOPER_RELEASE') throw new Error(`Only PENDING_DEVELOPER_RELEASE can be released; this version is ${state}.`);
  await api.post('/v1/appStoreVersionReleaseRequests', { data: { type: 'appStoreVersionReleaseRequests',
    relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } } });
  return { status: 'released', state: stateOf(await api.get(`/v1/appStoreVersions/${versionId}`)) };
}
