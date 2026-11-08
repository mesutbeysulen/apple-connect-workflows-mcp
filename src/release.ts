import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import { submitForReview, type ReviewAPI, type ReviewResult } from './review.js';
import { EDITABLE_VERSION_STATES, validId, versionOfApp } from './apple-rules.js';

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
  'App Privacy labels: Apple offers no API for these; complete them in App Store Connect',
  'Screenshot coverage for each required device size',
  'App Review guideline compliance and final Apple validation',
];
/** Read-only pre-submission report. It lists what is locally verifiable; Apple's own validation still decides. */
export async function releaseReadiness(api: ReadinessAPI, appId: string, versionId: string): Promise<ReadinessReport> {
  if (![appId, versionId].every(validId)) throw new Error('Invalid app or version ID.');
  const version = await versionOfApp(api, appId, versionId);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const state = String(version.attributes.appVersionState ?? version.attributes.appStoreState ?? 'UNKNOWN');
  const versionString = String(version.attributes.versionString ?? '');
  // READY_FOR_REVIEW means the version already sits in an unsent review draft.
  if (![...EDITABLE_VERSION_STATES, 'READY_FOR_REVIEW'].includes(state)) blockers.push(`Version state ${state} cannot be submitted.`);
  if (blank(version.attributes.copyright)) blockers.push('Version copyright is empty. Fix: version-update --copyright.');

  const build = await optional(api, `/v1/appStoreVersions/${versionId}/build`);
  if (!build) blockers.push('No build is attached to this version. Fix: version-build-set.');
  else {
    if (build.attributes.processingState !== 'VALID') blockers.push(`Attached build is not VALID: ${build.attributes.processingState ?? 'unknown'}.`);
    if (build.attributes.expired === true) blockers.push('Attached build has expired.');
    if (build.attributes.usesNonExemptEncryption === null || build.attributes.usesNonExemptEncryption === undefined) blockers.push('Attached build has no export compliance answer (usesNonExemptEncryption). Fix: build-compliance.');
  }

  const versions = await api.list(`/v1/apps/${appId}/appStoreVersions?limit=200`, 2000);
  if (versions.truncated) blockers.push('Version list is incomplete; cannot tell whether release notes are required.');
  const released = versions.data.some(row => row.id !== versionId && ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(String(row.attributes.appVersionState ?? row.attributes.appStoreState)));
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (localizations.truncated) blockers.push('Localization list is incomplete; some locales were not checked.');
  if (!localizations.data.length) blockers.push('Version has no localizations. Fix: version-localize or metadata-sync.');
  for (const localization of localizations.data) {
    const locale = String(localization.attributes.locale ?? localization.id);
    for (const [field, label] of [['description', 'description'], ['keywords', 'keywords'], ['supportUrl', 'support URL']] as const) {
      if (blank(localization.attributes[field])) blockers.push(`${locale}: ${label} is empty. Fix: metadata-sync.`);
    }
    if (released && blank(localization.attributes.whatsNew)) blockers.push(`${locale}: release notes are empty on an update. Fix: metadata-sync.`);
    const placements = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/placements?limit=200`, 200);
    if (placements.truncated) blockers.push(`${locale}: placement list is incomplete.`);
    for (const placement of placements.data) if (placement.attributes.state === 'FAILED') warnings.push(`${locale}: ${placement.attributes.placementType ?? 'asset'} placement ${placement.id} failed processing.`);
    let shots = placements.data.filter(p => p.attributes.placementType === 'APP_SCREENSHOT' && p.attributes.state !== 'FAILED').length;
    if (!shots) {
      const sets = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=200`, 200);
      for (const set of sets.data) {
        const rows = await api.list(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=200`, 200);
        // Abandoned reservations and failed uploads are not usable screenshots.
        shots += rows.data.filter(row => ['COMPLETE', 'UPLOAD_COMPLETE'].includes(String((row.attributes.assetDeliveryState as { state?: string } | undefined)?.state))).length;
      }
    }
    if (!shots) blockers.push(`${locale}: no screenshots. Fix: screenshots-sync.`);
  }

  const review = await optional(api, `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (!review) blockers.push('App Review contact details are missing. Fix: review-detail-set.');
  else for (const field of ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail']) if (blank(review.attributes[field])) blockers.push(`App Review detail ${field} is empty. Fix: review-detail-set.`);

  const app = await api.get(`/v1/apps/${appId}`);
  if (blank(app.attributes.contentRightsDeclaration)) blockers.push('Content rights declaration is not set. Fix: app-update --content-rights.');
  const infos = await api.list(`/v1/apps/${appId}/appInfos?limit=50`, 50);
  const info = infos.data.find(row => EDITABLE_VERSION_STATES.includes(String(row.attributes.appStoreState ?? row.attributes.state))) ?? infos.data[0];
  if (!info) blockers.push('App information is unavailable.');
  else {
    if (!await optional(api, `/v1/appInfos/${info.id}/primaryCategory`)) blockers.push('Primary category is not set. Fix: app-category-set.');
    const rating = await optional(api, `/v1/appInfos/${info.id}/ageRatingDeclaration`);
    if (!rating || Object.values(rating.attributes).every(blank)) blockers.push('Age rating questionnaire is not answered. Fix: age-rating-set.');
    const infoLocalizations = await api.list(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`, 2000);
    if (infoLocalizations.truncated) blockers.push('App information locale list is incomplete.');
    for (const row of infoLocalizations.data) {
      const locale = String(row.attributes.locale ?? row.id);
      if (blank(row.attributes.name)) blockers.push(`${locale}: app name is empty. Fix: app-info-set.`);
      if (blank(row.attributes.privacyPolicyUrl)) blockers.push(`${locale}: privacy policy URL is empty. Fix: app-info-set.`);
    }
  }
  if (!await optional(api, `/v1/apps/${appId}/appPriceSchedule`)) blockers.push('App price schedule is not set. Fix: app-price-set.');
  if (!await optional(api, `/v1/apps/${appId}/appAvailabilityV2`)) warnings.push('App availability is not set or could not be read. Fix: availability-set.');
  return { ready: !blockers.length, appId, versionId, versionString, state, blockers, warnings, notChecked: NOT_CHECKABLE };
}
function confirmVersion(version: Resource, typed: string): void {
  if (version.attributes.versionString !== typed) throw new Error(`--version-string ${typed} does not match this version (${version.attributes.versionString}).`);
}
/** Submits a version only when the readiness report has no blockers and the operator typed its version string. */
export async function submitRelease(input: { account: Account; appId: string; versionId: string; versionString: string }, api: ReadinessAPI & ReviewAPI): Promise<ReviewResult & { warnings: string[] }> {
  const { account, appId, versionId, versionString } = input;
  requireWrite(account, appId);
  if (!validId(versionId)) throw new Error('Invalid version ID.');
  const version = await versionOfApp(api, appId, versionId);
  confirmVersion(version, versionString);
  const platform = String(version.attributes.platform ?? 'IOS');
  const items = [{ relation: 'appStoreVersion' as const, id: versionId }];
  // After a lost response the version is already with Apple; reconcile instead of re-checking an edit-only report.
  if (['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(String(version.attributes.appVersionState ?? version.attributes.appStoreState))) {
    return { ...await submitForReview({ account, appId, platform, items }, api), warnings: [] };
  }
  const report = await releaseReadiness(api, appId, versionId);
  if (!report.ready) throw new Error(`Release is not ready:\n- ${report.blockers.join('\n- ')}`);
  return { ...await submitForReview({ account, appId, platform, items }, api), warnings: report.warnings };
}
/** Releases an approved version that is waiting for the developer. This cannot be undone. */
export async function publishRelease(input: { account: Account; appId: string; versionId: string; versionString: string }, api: ReadinessAPI & Pick<ReviewAPI, 'post'>): Promise<{ status: 'released' | 'already_released'; state: string }> {
  const { account, appId, versionId, versionString } = input;
  requireWrite(account, appId);
  if (!validId(versionId)) throw new Error('Invalid version ID.');
  const version = await versionOfApp(api, appId, versionId);
  confirmVersion(version, versionString);
  const stateOf = (r: Resource) => String(r.attributes.appVersionState ?? r.attributes.appStoreState ?? 'UNKNOWN');
  const state = stateOf(version);
  if (['PROCESSING_FOR_DISTRIBUTION', 'PROCESSING_FOR_APP_STORE', 'READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'].includes(state)) return { status: 'already_released', state };
  if (state !== 'PENDING_DEVELOPER_RELEASE') throw new Error(`Only PENDING_DEVELOPER_RELEASE can be released; this version is ${state}.`);
  await api.post('/v1/appStoreVersionReleaseRequests', { data: { type: 'appStoreVersionReleaseRequests',
    relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } } });
  return { status: 'released', state: stateOf(await api.get(`/v1/appStoreVersions/${versionId}`)) };
}
