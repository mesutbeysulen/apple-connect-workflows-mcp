import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { requireAccountWrite, requireWrite, type Account } from './config.js';
import { AppleError, type Method, type Resource } from './apple.js';
import { EDITABLE_VERSION_STATES, validId, versionOfApp } from './apple-rules.js';
import { imageInfo } from './creative-assets.js';
import { readImage } from './screenshots.js';
import { putFilePart, validateOperations } from './upload-transfer.js';
import { submitForReview, type ReviewAPI } from './review.js';

export interface ListingAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<void>;
}
const rel = (type: string, id: string) => ({ data: { type, id } });
const needApp = (appId: string) => { if (!/^\d+$/.test(appId)) throw new Error('Invalid app ID.'); };
async function optional(api: Pick<ListingAPI, 'get'>, path: string): Promise<Resource | undefined> {
  try { return (await api.get(path)) ?? undefined; }
  catch (error) { if (error instanceof AppleError && error.status === 404) return undefined; throw error; }
}
async function all(api: Pick<ListingAPI, 'list'>, path: string): Promise<Resource[]> {
  const rows = await api.list(path, 2000);
  if (rows.truncated) throw new Error(`Incomplete list at ${path.split('?')[0]}; refusing to continue.`);
  return rows.data;
}
/** Reserves, uploads and commits one file with an MD5 checksum, the pattern most Apple file resources share. */
async function uploadFile(api: ListingAPI, resource: string, attributes: Record<string, unknown>, relationships: Record<string, unknown>, filePath: string, size: number, fetcher: typeof fetch, commit: (md5: string) => Record<string, unknown> = md5 => ({ uploaded: true, sourceFileChecksum: md5 })) {
  const reserved = await api.post(`/v1/${resource}`, { data: { type: resource, attributes, relationships } });
  for (const op of validateOperations(reserved.attributes.uploadOperations, size)) await putFilePart(op, filePath, fetcher);
  const md5 = createHash('md5').update(await readFile(filePath)).digest('hex');
  await api.patch(`/v1/${resource}/${reserved.id}`, resource, reserved.id, commit(md5));
  return reserved.id;
}

// ---- Custom license agreement ----
/** Replaces Apple's standard EULA with your own text in the given territories. Previews unless execute. */
export async function setEula(input: { account: Account; appId: string; filePath: string; territories: string[] | 'all'; execute?: boolean }, api: ListingAPI) {
  const { account, appId, filePath, execute = false } = input;
  if (execute) requireWrite(account, appId);
  needApp(appId);
  if (!isAbsolute(filePath)) throw new Error('Use an absolute path to a plain-text agreement.');
  const text = (await readFile(filePath, 'utf8')).trim();
  if (!text) throw new Error('Agreement file is empty.');
  const known = (await all(api, '/v1/territories?limit=200')).map(row => row.id);
  const territories = input.territories === 'all' ? known : [...new Set(input.territories)];
  const unknown = territories.filter(t => !known.includes(t));
  if (!territories.length || unknown.length) throw new Error(unknown.length ? `Unknown territories: ${unknown.join(', ')}.` : 'Provide --territories or --all.');
  const current = await optional(api, `/v1/apps/${appId}/endUserLicenseAgreement`);
  const preview = { dryRun: !execute, appId, characters: [...text].length, territories: territories.length, replaces: current ? 'your existing custom agreement' : "Apple's standard agreement" };
  if (!execute) return preview;
  const relationships = { territories: { data: territories.map(id => ({ type: 'territories', id })) } };
  if (current) {
    await api.request('PATCH', `/v1/endUserLicenseAgreements/${current.id}`, { data: { type: 'endUserLicenseAgreements', id: current.id, attributes: { agreementText: text }, relationships } });
    return { ...preview, status: 'updated' as const, eulaId: current.id };
  }
  const created = await api.post('/v1/endUserLicenseAgreements', { data: { type: 'endUserLicenseAgreements', attributes: { agreementText: text }, relationships: { app: rel('apps', appId), ...relationships } } });
  return { ...preview, status: 'created' as const, eulaId: created.id };
}
/** Removes the custom agreement so Apple's standard EULA applies again. */
export async function removeEula(input: { account: Account; appId: string; execute?: boolean }, api: ListingAPI) {
  const { account, appId, execute = false } = input;
  if (execute) requireWrite(account, appId);
  needApp(appId);
  const current = await optional(api, `/v1/apps/${appId}/endUserLicenseAgreement`);
  if (!current) return { status: 'none' as const };
  if (!execute) return { dryRun: true, eulaId: current.id, effect: "Apple's standard agreement applies again." };
  await api.delete(`/v1/endUserLicenseAgreements/${current.id}`);
  return { status: 'removed' as const, eulaId: current.id };
}

// ---- Accessibility declarations (App Store accessibility labels) ----
export const ACCESSIBILITY_FEATURES: Record<string, string> = {
  voiceover: 'supportsVoiceover', 'voice-control': 'supportsVoiceControl', 'larger-text': 'supportsLargerText', 'dark-interface': 'supportsDarkInterface',
  'differentiate-without-color': 'supportsDifferentiateWithoutColorAlone', 'sufficient-contrast': 'supportsSufficientContrast', 'reduced-motion': 'supportsReducedMotion',
  captions: 'supportsCaptions', 'audio-descriptions': 'supportsAudioDescriptions',
};
const DEVICES = ['IPHONE', 'IPAD', 'APPLE_TV', 'APPLE_WATCH', 'MAC', 'VISION'];
/** Declares exactly which accessibility features one device family supports; unlisted features are set to false. */
export async function setAccessibility(input: { account: Account; appId: string; device: string; supports: string[]; publish?: boolean }, api: ListingAPI) {
  const { account, appId, device, supports, publish = false } = input;
  requireWrite(account, appId); needApp(appId);
  if (!DEVICES.includes(device)) throw new Error(`Device must be one of ${DEVICES.join(', ')}.`);
  const unknown = supports.filter(s => !ACCESSIBILITY_FEATURES[s]);
  if (unknown.length) throw new Error(`Unknown features: ${unknown.join(', ')}. Use ${Object.keys(ACCESSIBILITY_FEATURES).join(', ')}.`);
  const flags = Object.fromEntries(Object.entries(ACCESSIBILITY_FEATURES).map(([name, field]) => [field, supports.includes(name)]));
  const existing = (await all(api, `/v1/apps/${appId}/accessibilityDeclarations?${new URLSearchParams({ 'filter[deviceFamily]': device, limit: '50' })}`))
    .find(row => !['REPLACED'].includes(String(row.attributes.state)));
  let id: string; let status: 'created' | 'updated' | 'unchanged';
  if (!existing) {
    id = (await api.post('/v1/accessibilityDeclarations', { data: { type: 'accessibilityDeclarations', attributes: { deviceFamily: device, ...flags }, relationships: { app: rel('apps', appId) } } })).id;
    status = 'created';
  } else {
    id = existing.id;
    const changes = Object.fromEntries(Object.entries(flags).filter(([key, value]) => existing.attributes[key] !== value));
    status = Object.keys(changes).length ? 'updated' : 'unchanged';
    if (status === 'updated') await api.patch(`/v1/accessibilityDeclarations/${id}`, 'accessibilityDeclarations', id, changes);
  }
  // Publishing makes the labels visible on the product page.
  if (publish) await api.patch(`/v1/accessibilityDeclarations/${id}`, 'accessibilityDeclarations', id, { publish: true });
  return { status, declarationId: id, device, supported: supports, published: publish };
}

// ---- Routing app coverage (navigation apps) ----
/** Uploads the GeoJSON coverage file a routing app needs before review. Apple allows a single MultiPolygon. */
export async function uploadRoutingCoverage(input: { account: Account; appId: string; versionId: string; filePath: string }, api: ListingAPI, fetcher: typeof fetch = fetch) {
  const { account, appId, versionId, filePath } = input;
  requireWrite(account, appId);
  if (!isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.geojson')) throw new Error('Use an absolute path to a .geojson file.');
  let geo: { type?: string; geometry?: { type?: string }; features?: { geometry?: { type?: string } }[] };
  try { geo = JSON.parse(await readFile(filePath, 'utf8')); } catch { throw new Error('Coverage file is not valid JSON.'); }
  const geometries = geo.type === 'FeatureCollection' ? (geo.features ?? []).map(f => f.geometry?.type) : geo.type === 'Feature' ? [geo.geometry?.type] : [geo.type];
  if (geometries.length !== 1 || geometries[0] !== 'MultiPolygon') throw new Error('The coverage file must contain exactly one MultiPolygon.');
  const version = await versionOfApp(api, appId, versionId);
  if (!EDITABLE_VERSION_STATES.includes(String(version.attributes.appStoreState))) throw new Error(`Version is not editable: ${version.attributes.appStoreState}`);
  const size = (await stat(filePath)).size;
  const previous = await optional(api, `/v1/appStoreVersions/${versionId}/routingAppCoverage`);
  if (previous) await api.delete(`/v1/routingAppCoverages/${previous.id}`);
  const id = await uploadFile(api, 'routingAppCoverages', { fileName: basename(filePath), fileSize: size }, { appStoreVersion: rel('appStoreVersions', versionId) }, filePath, size, fetcher);
  return { status: 'uploaded' as const, coverageId: id, replaced: previous?.id ?? null };
}

// ---- Custom Product Page search keywords ----
/** Sets which of the app's own keywords a Custom Product Page appears for in search. */
export async function setCustomPageKeywords(input: { account: Account; appId: string; localizationId: string; keywords: string[] }, api: ListingAPI) {
  const { account, appId, localizationId } = input;
  requireWrite(account, appId); needApp(appId);
  if (!validId(localizationId)) throw new Error('Invalid localization ID.');
  const wanted = [...new Set(input.keywords.map(k => k.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) throw new Error('Provide at least one keyword.');
  const localization = await api.get(`/v1/appCustomProductPageLocalizations/${localizationId}`);
  const locale = String(localization.attributes.locale ?? '');
  // The page must belong to this app; its keywords come from the app's own keyword list for the same locale.
  let owned = false;
  for (const page of await all(api, `/v1/apps/${appId}/appCustomProductPages?limit=200`)) {
    for (const version of await all(api, `/v1/appCustomProductPages/${page.id}/appCustomProductPageVersions?limit=200`)) {
      if ((await all(api, `/v1/appCustomProductPageVersions/${version.id}/appCustomProductPageLocalizations?limit=200`)).some(row => row.id === localizationId)) owned = true;
    }
  }
  if (!owned) throw new Error('Localization does not belong to this app.');
  const appKeywords = await all(api, `/v1/apps/${appId}/searchKeywords?${new URLSearchParams({ 'filter[locale]': locale, limit: '200' })}`);
  const byWord = new Map(appKeywords.map(row => [String(row.id).toLowerCase(), row.id]));
  const missing = wanted.filter(word => !byWord.has(word));
  if (missing.length) throw new Error(`Not in the app's ${locale} keywords: ${missing.join(', ')}. A page can only use keywords the app already has.`);
  const current = (await all(api, `/v1/appCustomProductPageLocalizations/${localizationId}/searchKeywords?limit=200`)).map(row => row.id);
  const target = wanted.map(word => byWord.get(word)!);
  const add = target.filter(id => !current.includes(id)); const remove = current.filter(id => !target.includes(id));
  if (add.length) await api.request('POST', `/v1/appCustomProductPageLocalizations/${localizationId}/relationships/searchKeywords`, { data: add.map(id => ({ type: 'appKeywords', id })) });
  if (remove.length) await api.request('DELETE', `/v1/appCustomProductPageLocalizations/${localizationId}/relationships/searchKeywords`, { data: remove.map(id => ({ type: 'appKeywords', id })) });
  return { localizationId, locale, added: add, removed: remove, keywords: target };
}

// ---- App Clips ----
async function ownedClip(api: ListingAPI, appId: string, clipId: string): Promise<void> {
  needApp(appId);
  if (!validId(clipId) || !(await all(api, `/v1/apps/${appId}/appClips?limit=200`)).some(row => row.id === clipId)) throw new Error('App Clip does not belong to this app.');
}
async function ownedExperience(api: ListingAPI, appId: string, experienceId: string): Promise<void> {
  needApp(appId);
  for (const clip of await all(api, `/v1/apps/${appId}/appClips?limit=200`)) {
    if ((await all(api, `/v1/appClips/${clip.id}/appClipDefaultExperiences?limit=200`)).some(row => row.id === experienceId)) return;
  }
  throw new Error('App Clip experience does not belong to this app.');
}
/** Creates or updates the default App Clip experience, optionally released with an App Store version. */
export async function setClipDefaultExperience(input: { account: Account; appId: string; clipId: string; action: string; versionId?: string }, api: ListingAPI) {
  const { account, appId, clipId, action, versionId } = input;
  requireWrite(account, appId);
  if (!['OPEN', 'VIEW', 'PLAY'].includes(action)) throw new Error('Action must be OPEN, VIEW or PLAY.');
  await ownedClip(api, appId, clipId);
  if (versionId) await versionOfApp(api, appId, versionId);
  const release = versionId ? { releaseWithAppStoreVersion: rel('appStoreVersions', versionId) } : {};
  const existing = (await all(api, `/v1/appClips/${clipId}/appClipDefaultExperiences?limit=200`))[0];
  if (!existing) {
    const created = await api.post('/v1/appClipDefaultExperiences', { data: { type: 'appClipDefaultExperiences', attributes: { action }, relationships: { appClip: rel('appClips', clipId), ...release } } });
    return { status: 'created' as const, experienceId: created.id };
  }
  await api.request('PATCH', `/v1/appClipDefaultExperiences/${existing.id}`, { data: { type: 'appClipDefaultExperiences', id: existing.id, attributes: { action }, ...(versionId ? { relationships: release } : {}) } });
  return { status: 'updated' as const, experienceId: existing.id };
}
/** App Clip card subtitle per language. Apple shows it under the card title. */
export async function localizeClipExperience(input: { account: Account; appId: string; experienceId: string; locale: string; subtitle: string }, api: ListingAPI) {
  const { account, appId, experienceId, locale, subtitle } = input;
  requireWrite(account, appId);
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new Error(`Invalid locale ${locale}.`);
  await ownedExperience(api, appId, experienceId);
  const existing = (await all(api, `/v1/appClipDefaultExperiences/${experienceId}/appClipDefaultExperienceLocalizations?limit=200`)).find(row => row.attributes.locale === locale);
  if (!existing) return { status: 'created' as const, localizationId: (await api.post('/v1/appClipDefaultExperienceLocalizations', { data: { type: 'appClipDefaultExperienceLocalizations', attributes: { locale, subtitle }, relationships: { appClipDefaultExperience: rel('appClipDefaultExperiences', experienceId) } } })).id };
  if (existing.attributes.subtitle === subtitle) return { status: 'unchanged' as const, localizationId: existing.id };
  await api.patch(`/v1/appClipDefaultExperienceLocalizations/${existing.id}`, 'appClipDefaultExperienceLocalizations', existing.id, { subtitle });
  return { status: 'updated' as const, localizationId: existing.id };
}
/** Uploads the App Clip card header: 1800x1200 pixels, PNG or JPEG, no transparency, per App Store Connect Help. */
export async function uploadClipHeader(input: { account: Account; appId: string; experienceId: string; locale: string; filePath: string }, api: ListingAPI, fetcher: typeof fetch = fetch) {
  const { account, appId, experienceId, locale, filePath } = input;
  requireWrite(account, appId);
  const { name, bytes } = await readImage(filePath);
  const info = imageInfo(bytes);
  if (info.width !== 1800 || info.height !== 1200) throw new Error(`App Clip header images must be 1800x1200 pixels; this one is ${info.width}x${info.height}.`);
  if (info.hasAlpha) throw new Error('App Clip header images must not have transparency.');
  await ownedExperience(api, appId, experienceId);
  const localization = (await all(api, `/v1/appClipDefaultExperiences/${experienceId}/appClipDefaultExperienceLocalizations?limit=200`)).find(row => row.attributes.locale === locale);
  if (!localization) throw new Error(`Add the ${locale} language first with appclip-localize.`);
  const previous = await optional(api, `/v1/appClipDefaultExperienceLocalizations/${localization.id}/appClipHeaderImage`);
  if (previous) await api.delete(`/v1/appClipHeaderImages/${previous.id}`);
  const id = await uploadFile(api, 'appClipHeaderImages', { fileName: name, fileSize: bytes.length }, { appClipDefaultExperienceLocalization: rel('appClipDefaultExperienceLocalizations', localization.id) }, filePath, bytes.length, fetcher);
  return { status: 'uploaded' as const, imageId: id, replaced: previous?.id ?? null };
}
/** The invocation URLs App Review uses to open the App Clip. */
export async function setClipReviewUrls(input: { account: Account; appId: string; experienceId: string; urls: string[] }, api: ListingAPI) {
  const { account, appId, experienceId, urls } = input;
  requireWrite(account, appId);
  if (!urls.length || !urls.every(u => URL.canParse(u) && new URL(u).protocol === 'https:')) throw new Error('Provide one or more https invocation URLs.');
  await ownedExperience(api, appId, experienceId);
  const existing = await optional(api, `/v1/appClipDefaultExperiences/${experienceId}/appClipAppStoreReviewDetail`);
  if (!existing) return { status: 'created' as const, id: (await api.post('/v1/appClipAppStoreReviewDetails', { data: { type: 'appClipAppStoreReviewDetails', attributes: { invocationUrls: urls }, relationships: { appClipDefaultExperience: rel('appClipDefaultExperiences', experienceId) } } })).id };
  await api.patch(`/v1/appClipAppStoreReviewDetails/${existing.id}`, 'appClipAppStoreReviewDetails', existing.id, { invocationUrls: urls });
  return { status: 'updated' as const, id: existing.id };
}

// ---- Apple-hosted background assets (Apple's guide "Uploading and versioning Apple hosted background assets") ----
export async function createAssetPack(input: { account: Account; appId: string; identifier: string }, api: ListingAPI) {
  const { account, appId, identifier } = input;
  requireWrite(account, appId); needApp(appId);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(identifier)) throw new Error('Asset pack identifier may use letters, digits, dot, dash and underscore.');
  const found = (await all(api, `/v1/apps/${appId}/backgroundAssets?${new URLSearchParams({ 'filter[assetPackIdentifier]': identifier, limit: '10' })}`))[0];
  if (found) return { status: 'exists' as const, assetPackId: found.id };
  return { status: 'created' as const, assetPackId: (await api.post('/v1/backgroundAssets', { data: { type: 'backgroundAssets', attributes: { assetPackIdentifier: identifier }, relationships: { app: rel('apps', appId) } } })).id };
}
/**
 * Creates a new version of an asset pack and uploads its .aar archive, optionally checking the manifest first.
 * Apple numbers versions itself; each run adds one, so this previews unless execute is set.
 */
export async function uploadAssetPackVersion(input: { account: Account; appId: string; assetPackId: string; archivePath: string; manifestPath?: string; execute?: boolean }, api: ListingAPI, fetcher: typeof fetch = fetch) {
  const { account, appId, assetPackId, archivePath, manifestPath, execute = false } = input;
  if (execute) requireWrite(account, appId);
  needApp(appId);
  if (!isAbsolute(archivePath) || !archivePath.toLowerCase().endsWith('.aar')) throw new Error('Use an absolute path to the .aar archive made by xcrun ba-package.');
  if (manifestPath !== undefined && (!isAbsolute(manifestPath) || !manifestPath.toLowerCase().endsWith('.json'))) throw new Error('Use an absolute path to the JSON manifest.');
  if (manifestPath) { try { JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new Error('Manifest is not valid JSON.'); } }
  const pack = (await all(api, `/v1/apps/${appId}/backgroundAssets?limit=200`)).find(row => row.id === assetPackId);
  if (!pack) throw new Error('Asset pack does not belong to this app.');
  const archiveSize = (await stat(archivePath)).size;
  const preview = { dryRun: !execute, assetPackId, identifier: pack.attributes.assetPackIdentifier, archive: basename(archivePath), archiveSize, manifestChecked: !!manifestPath,
    effect: 'Creates a new asset pack version; it reaches internal TestFlight after Apple processes it.' };
  if (!execute) return preview;
  const version = await api.post('/v1/backgroundAssetVersions', { data: { type: 'backgroundAssetVersions', relationships: { backgroundAsset: rel('backgroundAssets', assetPackId) } } });
  const relation = { backgroundAssetVersion: rel('backgroundAssetVersions', version.id) };
  if (manifestPath) {
    const size = (await stat(manifestPath)).size;
    await uploadFile(api, 'backgroundAssetUploadFiles', { assetType: 'MANIFEST', fileName: basename(manifestPath), fileSize: size }, relation, manifestPath, size, fetcher, () => ({ uploaded: true }));
  }
  const fileId = await uploadFile(api, 'backgroundAssetUploadFiles', { assetType: 'ASSET', fileName: basename(archivePath), fileSize: archiveSize }, relation, archivePath, archiveSize, fetcher, () => ({ uploaded: true }));
  return { ...preview, status: 'uploaded' as const, versionId: version.id, version: version.attributes?.version, uploadFileId: fileId };
}
/** Sends an asset pack version to App Review so it goes live with the App Store version of your app. */
export async function submitAssetPackVersion(input: { account: Account; appId: string; assetPackId: string; versionId: string }, api: ListingAPI & ReviewAPI) {
  const { account, appId, assetPackId, versionId } = input;
  requireWrite(account, appId);
  if (!(await all(api, `/v1/apps/${appId}/backgroundAssets?limit=200`)).some(row => row.id === assetPackId)) throw new Error('Asset pack does not belong to this app.');
  if (!(await all(api, `/v1/backgroundAssets/${assetPackId}/versions?limit=200`)).some(row => row.id === versionId)) throw new Error('Version does not belong to this asset pack.');
  return submitForReview({ account, appId, items: [{ relation: 'backgroundAssetVersion', id: versionId }] }, api);
}

// ---- EU alternative distribution ----
/** Registers the public key for alternative distribution packages. */
export async function setDistributionKey(input: { account: Account; appId: string; publicKeyPath: string }, api: ListingAPI) {
  const { account, appId, publicKeyPath } = input;
  requireWrite(account, appId); needApp(appId);
  if (!isAbsolute(publicKeyPath)) throw new Error('Use an absolute path to a PEM public key.');
  const pem = (await readFile(publicKeyPath, 'utf8')).trim();
  if (/PRIVATE KEY/.test(pem)) throw new Error('This is a private key. Pass only the public key.');
  if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(pem)) throw new Error('File is not a PEM public key.');
  const current = await optional(api, `/v1/apps/${appId}/alternativeDistributionKey`);
  if (current) throw new Error(`This app already has key ${current.id}. Delete it in App Store Connect or with api_write_plan before adding another.`);
  return { status: 'created' as const, keyId: (await api.post('/v1/alternativeDistributionKeys', { data: { type: 'alternativeDistributionKeys', attributes: { publicKey: pem }, relationships: { app: rel('apps', appId) } } })).id };
}
/** Adds a web domain allowed to distribute your apps in the EU. Team level. */
export async function addDistributionDomain(input: { account: Account; domain: string; referenceName: string }, api: ListingAPI) {
  const { account, domain, referenceName } = input;
  requireAccountWrite(account);
  if (!/^(?!-)[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/.test(domain) || !referenceName.trim()) throw new Error('Provide a domain such as apps.example.com and a reference name.');
  const found = (await all(api, '/v1/alternativeDistributionDomains?limit=200')).find(row => row.attributes.domain === domain);
  if (found) return { status: 'exists' as const, domainId: found.id };
  return { status: 'created' as const, domainId: (await api.post('/v1/alternativeDistributionDomains', { data: { type: 'alternativeDistributionDomains', attributes: { domain, referenceName } } })).id };
}
/** For marketplace apps: the catalog URL alternative app marketplaces search. */
export async function setMarketplaceSearch(input: { account: Account; appId: string; catalogUrl: string }, api: ListingAPI) {
  const { account, appId, catalogUrl } = input;
  requireWrite(account, appId); needApp(appId);
  if (!URL.canParse(catalogUrl) || new URL(catalogUrl).protocol !== 'https:') throw new Error('Catalog URL must be https.');
  const current = await optional(api, `/v1/apps/${appId}/marketplaceSearchDetail`);
  if (!current) return { status: 'created' as const, id: (await api.post('/v1/marketplaceSearchDetails', { data: { type: 'marketplaceSearchDetails', attributes: { catalogUrl }, relationships: { app: rel('apps', appId) } } })).id };
  if (current.attributes.catalogUrl === catalogUrl) return { status: 'unchanged' as const, id: current.id };
  await api.patch(`/v1/marketplaceSearchDetails/${current.id}`, 'marketplaceSearchDetails', current.id, { catalogUrl });
  return { status: 'updated' as const, id: current.id };
}
/** Requests the alternative distribution package for an approved App Store version, or returns the existing one. */
export async function createDistributionPackage(input: { account: Account; appId: string; versionId: string }, api: ListingAPI) {
  const { account, appId, versionId } = input;
  requireWrite(account, appId);
  await versionOfApp(api, appId, versionId);
  const current = await optional(api, `/v1/appStoreVersions/${versionId}/alternativeDistributionPackage`);
  if (current) return { status: 'exists' as const, packageId: current.id };
  return { status: 'created' as const, packageId: (await api.post('/v1/alternativeDistributionPackages', { data: { type: 'alternativeDistributionPackages', relationships: { appStoreVersion: rel('appStoreVersions', versionId) } } })).id };
}
