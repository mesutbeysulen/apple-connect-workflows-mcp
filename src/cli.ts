#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { userInfo } from 'node:os';
import { allHelp, findTopic, overview, topicHelp } from './help.js';
import { accountIdentity, loadConfig, requireCapability, type Account, type Capability, type Config } from './config.js';
import { PlanStore } from './plans.js';
import { ConnectService } from './service.js';
import { createServer } from './server.js';
import { screenshotClient, uploadScreenshot, resumeScreenshot } from './screenshots.js';
import { distributeToGroups } from './testflight.js';
import { waitForBuild } from './build-status.js';
import { uploadBuild, resumeBuild, cancelBuildUpload } from './build-upload.js';
import { createEncryptionDeclaration, uploadEncryptionDocument, attachEncryptionDeclaration } from './export-compliance.js';
import { uploadAsset, resumeAsset, orderPlacements, IMAGE_PLACEMENT_TYPES, type ImagePlacementType } from './asset-library.js';
import { createScreenshotSet, orderScreenshots } from './screenshot-sets.js';
import { cleanupStaleAssets } from './asset-cleanup.js';
import { uploadCreative, resumeCreative, submitCreatives, placeCreative, removeCreativePlacement, parseTargets, type CreativeKind } from './creative-assets.js';
import { releaseReadiness, submitRelease, publishRelease, manualCheckIds, type ManualCheckId } from './release.js';
import { createIap, createSubscription, createSubscriptionGroup, createProductVersion, localizeProduct, localizeProductVersion, setAppPrice, setIapPrice, setSubscriptionPrice, type ProductKind } from './commercial.js';
import { uploadProductVersionImage } from './product-images.js';
import { downloadSales, downloadFinance, requestAnalytics, downloadAnalytics } from './reports.js';
import { setIntroOffer, deleteIntroOffer } from './offers.js';
import * as extras from './commerce-extras.js';
import * as marketing from './marketing.js';
import * as team from './team-signing.js';
import * as gc from './game-center.js';
import * as ci from './xcode-cloud.js';
import * as listing from './listing-extras.js';
import { submitForReview } from './review.js';
import { createWebhook, deleteWebhook, pingWebhook, redeliverWebhook, setWebhookEnabled, webhookReceiver, webhookSecret } from './webhooks.js';
import { setupKey } from './key-setup.js';
import * as prep from './release-prep.js';
import { readMetadataFile, syncMetadata, syncScreenshots } from './bulk.js';
import { uploadPreview, placePreview } from './creative-assets.js';
import { applyApiPlan } from './api-plans.js';
import { smokeRead } from './smoke.js';
import { writeFileSync as writeFile } from 'node:fs';
import { isAbsolute } from 'node:path';

const options = {
  config: { type: 'string' }, plan: { type: 'string' }, digest: { type: 'string' }, account: { type: 'string' }, app: { type: 'string' },
  set: { type: 'string' }, version: { type: 'string' }, localization: { type: 'string' }, file: { type: 'string' }, screenshot: { type: 'string' },
  build: { type: 'string' }, group: { type: 'string' }, image: { type: 'string' }, order: { type: 'string' },
  'placement-group': { type: 'string' }, 'placement-type': { type: 'string' }, 'reference-name': { type: 'string' },
  'primary-locale': { type: 'string' }, 'content-rights': { type: 'string' }, subtitle: { type: 'string' }, 'privacy-url': { type: 'string' }, 'privacy-choices-url': { type: 'string' }, 'privacy-text': { type: 'string' },
  primary: { type: 'string' }, 'primary-sub1': { type: 'string' }, 'primary-sub2': { type: 'string' }, secondary: { type: 'string' }, 'secondary-sub1': { type: 'string' }, 'secondary-sub2': { type: 'string' },
  territories: { type: 'string' }, 'new-territories': { type: 'boolean' }, platform: { type: 'string' }, copyright: { type: 'string' }, 'release-type': { type: 'string' }, 'release-date': { type: 'string' }, 'uses-encryption': { type: 'string' },
  declaration: { type: 'string' }, 'app-description': { type: 'string' }, 'proprietary-crypto': { type: 'string' }, 'third-party-crypto': { type: 'string' }, 'french-store': { type: 'string' },
  keywords: { type: 'string' }, 'whats-new': { type: 'string' }, 'promotional-text': { type: 'string' }, 'support-url': { type: 'string' }, 'marketing-url': { type: 'string' }, dir: { type: 'string' },
  'first-name': { type: 'string' }, 'last-name': { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, notes: { type: 'string' }, 'demo-required': { type: 'string' }, 'demo-name': { type: 'string' },
  submission: { type: 'string' }, item: { type: 'string' }, state: { type: 'string' }, 'feedback-email': { type: 'string' }, 'public-link': { type: 'boolean' }, feedback: { type: 'boolean' }, emails: { type: 'string' }, tester: { type: 'string' }, review: { type: 'string' }, text: { type: 'string' }, identifier: { type: 'string' }, individual: { type: 'boolean' },
  placements: { type: 'string' }, 'preview-frame': { type: 'string' }, asset: { type: 'string' }, images: { type: 'string' }, videos: { type: 'string' }, video: { type: 'string' }, replace: { type: 'boolean' }, placement: { type: 'string' },
  'version-string': { type: 'string' }, 'product-id': { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, period: { type: 'string' }, 'group-level': { type: 'string' }, iap: { type: 'string' }, subscription: { type: 'string' }, locale: { type: 'string' }, description: { type: 'string' }, kind: { type: 'string' }, product: { type: 'string' }, 'custom-app-name': { type: 'string' },
  territory: { type: 'string' }, 'vendor-id': { type: 'string' }, supports: { type: 'string' }, 'publish-labels': { type: 'boolean' }, 'paid-months': { type: 'string' }, 'lapsed-min': { type: 'string' }, 'lapsed-max': { type: 'string' }, 'wait-months': { type: 'string' }, promote: { type: 'string' }, message: { type: 'string' }, header: { type: 'string' }, body: { type: 'string' }, subscriptions: { type: 'string' }, clip: { type: 'string' }, experience: { type: 'string' }, action: { type: 'string' }, urls: { type: 'string' }, 'asset-pack': { type: 'string' }, manifest: { type: 'string' }, 'pack-version': { type: 'string' }, 'public-key': { type: 'string' }, domain: { type: 'string' }, 'catalog-url': { type: 'string' }, workflow: { type: 'string' }, branch: { type: 'string' }, tag: { type: 'string' }, 'pull-request': { type: 'string' }, rebuild: { type: 'string' }, clean: { type: 'boolean' }, 'build-run': { type: 'string' }, artifact: { type: 'string' }, 'recurrence-start': { type: 'string' }, 'recurrence-duration': { type: 'string' }, 'recurrence-rule': { type: 'string' }, 'play-style': { type: 'string' }, 'min-players': { type: 'string' }, 'max-players': { type: 'string' }, 'party-code': { type: 'string' }, properties: { type: 'string' }, 'formatter-override': { type: 'string' }, 'app-version': { type: 'string' }, leaderboards: { type: 'string' }, activity: { type: 'string' }, ruleset: { type: 'string' }, expression: { type: 'string' }, weight: { type: 'string' }, 'language-version': { type: 'string' }, 'bundle-ids': { type: 'string' }, formatter: { type: 'string' }, sort: { type: 'string' }, 'range-start': { type: 'string' }, 'range-end': { type: 'string' }, visibility: { type: 'string' }, archived: { type: 'string' }, leaderboard: { type: 'string' }, title: { type: 'string' }, suffix: { type: 'string' }, 'suffix-singular': { type: 'string' }, achievement: { type: 'string' }, points: { type: 'string' }, 'show-before-earned': { type: 'string' }, repeatable: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, roles: { type: 'string' }, 'all-apps': { type: 'boolean' }, apps: { type: 'string' }, provisioning: { type: 'string' }, user: { type: 'string' }, invitation: { type: 'string' }, udid: { type: 'string' }, device: { type: 'string' }, status: { type: 'string' }, bundle: { type: 'string' }, capability: { type: 'string' }, csr: { type: 'string' }, certificate: { type: 'string' }, certificates: { type: 'string' }, devices: { type: 'string' }, 'all-devices': { type: 'boolean' }, profile: { type: 'string' }, page: { type: 'string' }, 'page-version': { type: 'string' }, visible: { type: 'string' }, 'deep-link': { type: 'string' }, badge: { type: 'string' }, purpose: { type: 'string' }, priority: { type: 'string' }, 'purchase-requirement': { type: 'string' }, publish: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, event: { type: 'string' }, 'event-name': { type: 'string' }, 'short-description': { type: 'string' }, 'long-description': { type: 'string' }, experiment: { type: 'string' }, traffic: { type: 'string' }, started: { type: 'string' }, treatment: { type: 'string' }, 'icon-name': { type: 'string' }, target: { type: 'string' }, id: { type: 'string' }, all: { type: 'boolean' }, 'offer-code': { type: 'string' }, prices: { type: 'string' }, eligibility: { type: 'string' }, 'offer-eligibility': { type: 'string' }, count: { type: 'string' }, expires: { type: 'string' }, environment: { type: 'string' }, 'custom-code': { type: 'string' }, 'visible-all': { type: 'string' }, enabled: { type: 'string' }, promoted: { type: 'string' }, 'interrupt-purchases': { type: 'string' }, 'renewal-rate': { type: 'string' }, testers: { type: 'string' }, 'offer-mode': { type: 'string' }, duration: { type: 'string' }, periods: { type: 'string' }, 'end-date': { type: 'string' }, offer: { type: 'string' }, 'region-code': { type: 'string' }, price: { type: 'string' }, 'start-date': { type: 'string' }, 'preserve-current-price': { type: 'boolean' },
  vendor: { type: 'string' }, subtype: { type: 'string' }, frequency: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, 'report-version': { type: 'string' }, access: { type: 'string' }, 'report-name': { type: 'string' }, granularity: { type: 'string' }, category: { type: 'string' },
  issuer: { type: 'string' }, p8: { type: 'string' }, 'key-id': { type: 'string' }, 'allow-app': { type: 'string' }, url: { type: 'string' }, events: { type: 'string' }, webhook: { type: 'string' }, delivery: { type: 'string' }, port: { type: 'string' }, limit: { type: 'string' },
  'display-type': { type: 'string' }, upload: { type: 'string' }, 'timeout-minutes': { type: 'string' }, 'interval-seconds': { type: 'string' }, 'older-than-hours': { type: 'string' }, 'manual-checks': { type: 'string' },
  'iap-version-ids': { type: 'string' }, 'subscription-version-ids': { type: 'string' }, 'subscription-group-version-ids': { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean' },
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];

function required<K extends keyof Values>(values: Values, ...keys: K[]): { [P in K]-?: NonNullable<Values[P]> } {
  const missing = keys.filter(key => values[key] === undefined || values[key] === '');
  if (missing.length) throw new Error(`${missing.map(k => `--${String(k)}`).join(', ')} required.`);
  return values as { [P in K]-?: NonNullable<Values[P]> };
}
const kindOf = (value: string): extras.ProductKind => { if (value !== 'iap' && value !== 'subscription') throw new Error('--kind must be iap or subscription.'); return value; };
const eventFields = (v: Values): marketing.EventFields => ({ badge: v.badge, purpose: v.purpose, priority: v.priority, primaryLocale: v['primary-locale'], deepLink: v['deep-link'],
  purchaseRequirement: v['purchase-requirement'], territories: v.territories === undefined ? undefined : ids(v.territories), publishStart: v.publish, eventStart: v.start, eventEnd: v.end });
/** --all-apps and --apps are mutually exclusive ways to set which apps a person can see. */
const access = (v: Values): team.Access => ({ roles: v.roles === undefined ? undefined : ids(v.roles), allAppsVisible: v['all-apps'] === true ? true : undefined, appIds: v.apps === undefined ? undefined : ids(v.apps) });
const gcKind = (value: string): gc.GameCenterKind => { if (!(gc.GAME_CENTER_KINDS as string[]).includes(value)) throw new Error(`--kind must be one of ${gc.GAME_CENTER_KINDS.join(', ')}.`); return value as gc.GameCenterKind; };
const numberOrUndefined = (value: string | undefined, flag: string) => { if (value === undefined) return undefined; const n = Number(value); if (!Number.isFinite(n)) throw new Error(`${flag} must be a number.`); return n; };
/** Item fields shared by gc-create and gc-update; each kind accepts only its own. */
const gcFields = (v: Values): gc.ItemFields => ({
  formatter: v.formatter, scoreSortType: v.sort, submissionType: v.submission, scoreRangeStart: v['range-start'], scoreRangeEnd: v['range-end'], visibility: v.visibility,
  recurrenceStartDate: v['recurrence-start'], recurrenceDuration: v['recurrence-duration'], recurrenceRule: v['recurrence-rule'],
  points: numberOrUndefined(v.points, '--points'), showBeforeEarned: yesNo(v['show-before-earned'], '--show-before-earned'), repeatable: yesNo(v.repeatable, '--repeatable'),
  playStyle: v['play-style'], minimumPlayersCount: numberOrUndefined(v['min-players'], '--min-players'), maximumPlayersCount: numberOrUndefined(v['max-players'], '--max-players'),
  supportsPartyCode: yesNo(v['party-code'], '--party-code'),
  properties: v.properties === undefined ? undefined : Object.fromEntries(ids(v.properties).map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--properties uses key=value pairs.'); return [pair.slice(0, at), pair.slice(at + 1)]; })),
});
const ids = (list: string) => list.split(',').map(s => s.trim()).filter(Boolean);
function yesNo(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new Error(`${flag} must be true or false.`);
  return value === 'true';
}
/** The test login password comes only from the environment, so it stays out of shell history and process lists. */
const contact = (v: Values): prep.ReviewContact => ({ contactFirstName: v['first-name'], contactLastName: v['last-name'], contactPhone: v.phone, contactEmail: v.email, notes: v.notes,
  demoAccountRequired: yesNo(v['demo-required'], '--demo-required'), demoAccountName: v['demo-name'], demoAccountPassword: process.env.APPLE_REVIEW_DEMO_PASSWORD });

type Handler = (values: Values, ctx: { service: ConnectService; store: PlanStore; account: () => Account }) => Promise<unknown>;
const commands: Record<string, Handler> = {
  'asset-upload': async (v, { store, account }) => {
    const a = required(v, 'app', 'version', 'localization', 'placement-group', 'file');
    const type = v['placement-type'] ?? 'APP_SCREENSHOT';
    if (!(IMAGE_PLACEMENT_TYPES as readonly string[]).includes(type)) throw new Error(`--placement-type must be ${IMAGE_PLACEMENT_TYPES.join(' or ')}.`);
    const acc = account();
    return uploadAsset({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, placementGroup: a['placement-group'],
      placementType: type as ImagePlacementType, filePath: a.file, referenceName: v['reference-name'] }, screenshotClient(acc), fetch, store);
  },
  'asset-resume': async (v, { store, account }) => { const acc = account(); return resumeAsset(required(v, 'image').image, acc, store, screenshotClient(acc)); },
  'asset-order': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'localization', 'placement-group', 'order');
    const acc = account();
    return orderPlacements({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, placementGroup: a['placement-group'], placementIds: ids(a.order) }, screenshotClient(acc));
  },
  'asset-cleanup': async (v, { store, account }) => {
    const a = required(v, 'app');
    const hours = v['older-than-hours'] === undefined ? undefined : Number(v['older-than-hours']);
    const acc = account();
    return cleanupStaleAssets({ account: acc, appId: a.app, olderThanHours: hours, execute: v.execute === true }, screenshotClient(acc), store);
  },
  'screenshot-set-create': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'localization', 'display-type');
    const acc = account();
    return createScreenshotSet({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, displayType: a['display-type'] }, screenshotClient(acc));
  },
  'screenshot-upload': async (v, { store, account }) => {
    const a = required(v, 'app', 'version', 'localization', 'set', 'file');
    const acc = account();
    return uploadScreenshot({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, setId: a.set, filePath: a.file }, screenshotClient(acc), fetch, store);
  },
  'screenshot-resume': async (v, { store, account }) => { const acc = account(); return resumeScreenshot(required(v, 'screenshot').screenshot, acc, store, screenshotClient(acc)); },
  'screenshot-order': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'localization', 'set', 'order');
    const acc = account();
    return orderScreenshots({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, setId: a.set, screenshotIds: ids(a.order) }, screenshotClient(acc));
  },
  'testflight-distribute': async (v, { account }) => {
    const a = required(v, 'app', 'build', 'group');
    const acc = account();
    const result = await distributeToGroups({ account: acc, appId: a.app, buildId: a.build, groupIds: ids(a.group) }, screenshotClient(acc));
    if (!result.ok) process.exitCode = 1;
    return result;
  },
  'build-upload': async (v, { store, account }) => {
    const a = required(v, 'app', 'version', 'build', 'file');
    const acc = account();
    return uploadBuild({ account: acc, appId: a.app, version: a.version, build: a.build, filePath: a.file, platform: v.platform }, screenshotClient(acc), fetch, store);
  },
  'build-resume': async (v, { store, account }) => { const acc = account(); return resumeBuild(required(v, 'upload').upload, acc, store, screenshotClient(acc)); },
  'build-cancel': async (v, { store, account }) => { const a = required(v, 'app', 'upload'); const acc = account(); return cancelBuildUpload({ account: acc, appId: a.app, uploadId: a.upload }, screenshotClient(acc), store); },
  'build-wait': async (v, { account }) => {
    const a = required(v, 'upload');
    const minutes = Number(v['timeout-minutes'] ?? 60); const seconds = Number(v['interval-seconds'] ?? 30);
    if (!(minutes >= 1 && minutes <= 24 * 60) || !(seconds >= 10 && seconds <= 600)) throw new Error('--timeout-minutes 1-1440, --interval-seconds 10-600.');
    const result = await waitForBuild(screenshotClient(account()), a.upload, { timeoutMs: minutes * 60_000, intervalMs: seconds * 1000,
      onProgress: s => console.error(`${new Date().toISOString()} upload=${s.uploadState} build=${s.buildId ?? '-'} processing=${s.processingState ?? '-'}`),
      onRetry: e => console.error(`${new Date().toISOString()} retrying after: ${e instanceof Error ? e.message : 'read failed'}`) });
    if (!result.ok) process.exitCode = 1;
    return result;
  },
  'bundle-id-create': async (v, { account }) => { const a = required(v, 'identifier', 'name', 'platform'); const acc = account(); return prep.createBundleId({ account: acc, identifier: a.identifier, name: a.name, platform: a.platform }, screenshotClient(acc)); },
  'app-update': async (v, { account }) => { const a = required(v, 'app'); const acc = account(); return prep.updateApp({ account: acc, appId: a.app, primaryLocale: v['primary-locale'], contentRights: v['content-rights'] }, screenshotClient(acc)); },
  'app-info-set': async (v, { account }) => { const a = required(v, 'app', 'locale'); const acc = account(); return prep.setAppInfo({ account: acc, appId: a.app, locale: a.locale, name: v.name, subtitle: v.subtitle, privacyPolicyUrl: v['privacy-url'], privacyChoicesUrl: v['privacy-choices-url'], privacyPolicyText: v['privacy-text'] }, screenshotClient(acc)); },
  'app-category-set': async (v, { account }) => { const a = required(v, 'app'); const acc = account(); return prep.setCategories({ account: acc, appId: a.app, categories: { primary: v.primary, primarySub1: v['primary-sub1'], primarySub2: v['primary-sub2'], secondary: v.secondary, secondarySub1: v['secondary-sub1'], secondarySub2: v['secondary-sub2'] } }, screenshotClient(acc)); },
  'age-rating-set': async (v, { account }) => { const a = required(v, 'app', 'file'); const acc = account(); return prep.setAgeRating({ account: acc, appId: a.app, filePath: a.file }, screenshotClient(acc)); },
  'availability-set': async (v, { account }) => { const a = required(v, 'app', 'territories'); const acc = account(); return prep.setAvailability({ account: acc, appId: a.app, territories: ids(a.territories), availableInNewTerritories: v['new-territories'] === true, execute: v.execute === true }, screenshotClient(acc)); },
  'version-create': async (v, { account }) => { const a = required(v, 'app', 'platform', 'version-string'); const acc = account(); return prep.createVersion({ account: acc, appId: a.app, platform: a.platform, versionString: a['version-string'], copyright: v.copyright, releaseType: v['release-type'], earliestReleaseDate: v['release-date'] }, screenshotClient(acc)); },
  'version-update': async (v, { account }) => { const a = required(v, 'app', 'version'); const acc = account(); return prep.updateVersion({ account: acc, appId: a.app, versionId: a.version, copyright: v.copyright, releaseType: v['release-type'], earliestReleaseDate: v['release-date'], versionString: v['version-string'] }, screenshotClient(acc)); },
  'version-build-set': async (v, { account }) => { const a = required(v, 'app', 'version', 'build'); const acc = account(); return prep.attachBuild({ account: acc, appId: a.app, versionId: a.version, buildId: a.build }, screenshotClient(acc)); },
  'build-compliance': async (v, { account }) => { const a = required(v, 'app', 'build', 'uses-encryption'); const acc = account(); return prep.setBuildEncryption({ account: acc, appId: a.app, buildId: a.build, usesNonExemptEncryption: yesNo(a['uses-encryption'], '--uses-encryption')! }, screenshotClient(acc)); },
  'encryption-declaration-create': async (v, { account }) => {
    const a = required(v, 'app', 'app-description', 'proprietary-crypto', 'third-party-crypto', 'french-store');
    const acc = account();
    return createEncryptionDeclaration({ account: acc, appId: a.app, appDescription: a['app-description'],
      containsProprietaryCryptography: yesNo(a['proprietary-crypto'], '--proprietary-crypto')!,
      containsThirdPartyCryptography: yesNo(a['third-party-crypto'], '--third-party-crypto')!, availableOnFrenchStore: yesNo(a['french-store'], '--french-store')! }, screenshotClient(acc));
  },
  'encryption-document-upload': async (v, { account }) => { const a = required(v, 'app', 'declaration', 'file'); const acc = account();
    return uploadEncryptionDocument({ account: acc, appId: a.app, declarationId: a.declaration, filePath: a.file }, screenshotClient(acc)); },
  'build-encryption-attach': async (v, { account }) => { const a = required(v, 'app', 'declaration', 'build'); const acc = account();
    return attachEncryptionDeclaration({ account: acc, appId: a.app, declarationId: a.declaration, buildId: a.build }, screenshotClient(acc)); },
  'version-localize': async (v, { account }) => { const a = required(v, 'app', 'version', 'locale'); const acc = account(); return prep.setVersionLocale({ account: acc, appId: a.app, versionId: a.version, locale: a.locale, description: v.description, keywords: v.keywords, whatsNew: v['whats-new'], promotionalText: v['promotional-text'], supportUrl: v['support-url'], marketingUrl: v['marketing-url'] }, screenshotClient(acc)); },
  'metadata-sync': async (v, { account }) => { const a = required(v, 'app', 'version', 'file'); const acc = account(); return syncMetadata({ account: acc, appId: a.app, versionId: a.version, metadata: await readMetadataFile(a.file), execute: v.execute === true }, screenshotClient(acc)); },
  'screenshots-sync': async (v, { store, account }) => { const a = required(v, 'app', 'version', 'dir'); const acc = account(); return syncScreenshots({ account: acc, appId: a.app, versionId: a.version, dir: a.dir, replace: v.replace === true, execute: v.execute === true }, screenshotClient(acc), store); },
  'preview-upload': async (v, { store, account }) => { const a = required(v, 'app', 'file'); const acc = account(); return uploadPreview({ account: acc, appId: a.app, filePath: a.file, referenceName: v['reference-name'], previewFrameTimeCode: v['preview-frame'] }, screenshotClient(acc), fetch, store); },
  'preview-place': async (v, { account }) => { const a = required(v, 'app', 'version', 'localization', 'video', 'placement-group'); const acc = account(); return placePreview({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, videoId: a.video, placementGroup: a['placement-group'] }, screenshotClient(acc)); },
  'review-detail-set': async (v, { account }) => { const a = required(v, 'app', 'version'); const acc = account(); return prep.setReviewDetail({ account: acc, appId: a.app, versionId: a.version, ...contact(v) }, screenshotClient(acc)); },
  'review-attachment-upload': async (v, { account }) => { const a = required(v, 'app', 'version', 'file'); const acc = account(); return prep.uploadReviewAttachment({ account: acc, appId: a.app, versionId: a.version, filePath: a.file }, screenshotClient(acc)); },
  'review-cancel': async (v, { account }) => { const a = required(v, 'app', 'submission'); const acc = account(); return prep.cancelSubmission({ account: acc, appId: a.app, submissionId: a.submission }, screenshotClient(acc)); },
  'review-item-remove': async (v, { account }) => { const a = required(v, 'app', 'submission', 'item'); const acc = account(); return prep.removeReviewItem({ account: acc, appId: a.app, submissionId: a.submission, itemId: a.item }, screenshotClient(acc)); },
  'phased-release': async (v, { account }) => { const a = required(v, 'app', 'version', 'state'); const acc = account(); return prep.setPhasedRelease({ account: acc, appId: a.app, versionId: a.version, state: a.state }, screenshotClient(acc)); },
  'beta-info-set': async (v, { account }) => { const a = required(v, 'app', 'locale'); const acc = account(); return prep.setBetaAppInfo({ account: acc, appId: a.app, locale: a.locale, description: v.description, feedbackEmail: v['feedback-email'], marketingUrl: v['marketing-url'], privacyPolicyUrl: v['privacy-url'] }, screenshotClient(acc)); },
  'beta-notes-set': async (v, { account }) => { const a = required(v, 'app', 'build', 'locale', 'whats-new'); const acc = account(); return prep.setBetaBuildNotes({ account: acc, appId: a.app, buildId: a.build, locale: a.locale, whatsNew: a['whats-new'] }, screenshotClient(acc)); },
  'beta-review-detail-set': async (v, { account }) => { const a = required(v, 'app'); const acc = account(); return prep.setBetaReviewDetail({ account: acc, appId: a.app, ...contact(v) }, screenshotClient(acc)); },
  'beta-submit': async (v, { account }) => { const a = required(v, 'app', 'build'); const acc = account(); return prep.submitBetaReview({ account: acc, appId: a.app, buildId: a.build }, screenshotClient(acc)); },
  'beta-group-create': async (v, { account }) => { const a = required(v, 'app', 'name'); const acc = account(); return prep.createBetaGroup({ account: acc, appId: a.app, name: a.name, publicLink: v['public-link'], feedback: v.feedback }, screenshotClient(acc)); },
  'beta-tester-add': async (v, { account }) => { const a = required(v, 'app', 'group', 'emails'); const acc = account(); return prep.addBetaTesters({ account: acc, appId: a.app, groupId: a.group, testers: ids(a.emails).map(email => ({ email })) }, screenshotClient(acc)); },
  'beta-tester-remove': async (v, { account }) => { const a = required(v, 'app', 'group', 'tester'); const acc = account(); return prep.removeBetaTester({ account: acc, appId: a.app, groupId: a.group, testerId: a.tester }, screenshotClient(acc)); },
  'review-reply': async (v, { account }) => { const a = required(v, 'app', 'review', 'text'); const acc = account(); return prep.replyToReview({ account: acc, appId: a.app, reviewId: a.review, text: a.text }, screenshotClient(acc)); },
  'api-plan-show': async (v, { store }) => store.apiPlan(required(v, 'plan').plan),
  'api-apply': async (v, { store, service }) => {
    const a = required(v, 'plan', 'digest');
    const acc = service.account(store.apiPlan(a.plan).body.account);
    return applyApiPlan(a.plan, a.digest, acc, store, screenshotClient(acc));
  },
  'creative-upload': async (v, { store, account }) => {
    const a = required(v, 'app', 'placements', 'file');
    const acc = account();
    return uploadCreative({ account: acc, appId: a.app, targets: parseTargets(a.placements), filePath: a.file, referenceName: v['reference-name'], previewFrameTimeCode: v['preview-frame'] }, screenshotClient(acc), fetch, store);
  },
  'creative-resume': async (v, { store, account }) => { const acc = account(); return resumeCreative(required(v, 'asset').asset, acc, store, screenshotClient(acc)); },
  'creative-submit': async (v, { account }) => {
    const a = required(v, 'app');
    if (!v.images && !v.videos) throw new Error('--images or --videos required.');
    const acc = account();
    return submitCreatives({ account: acc, appId: a.app, imageIds: ids(v.images ?? ''), videoIds: ids(v.videos ?? '') }, screenshotClient(acc));
  },
  'creative-place': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'localization', 'placements');
    if (!!v.image === !!v.video) throw new Error('Pass exactly one of --image or --video.');
    const kind: CreativeKind = v.image ? 'image' : 'video';
    const acc = account();
    return placeCreative({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, kind, assetId: (v.image ?? v.video)!, targets: parseTargets(a.placements), placementGroup: v['placement-group'], replace: v.replace === true }, screenshotClient(acc));
  },
  'creative-remove': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'localization', 'placement');
    const acc = account();
    return removeCreativePlacement({ account: acc, appId: a.app, versionId: a.version, localizationId: a.localization, placementId: a.placement }, screenshotClient(acc));
  },
  'release-check': async (v, { account }) => {
    const a = required(v, 'app', 'version');
    const checks = ids(v['manual-checks'] ?? '') as ManualCheckId[];
    if (checks.some(id => !manualCheckIds.includes(id))) throw new Error(`--manual-checks must contain: ${manualCheckIds.join(',')}`);
    return releaseReadiness(screenshotClient(account()), a.app, a.version, checks);
  },
  'release-submit': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'version-string');
    const acc = account();
    const checks = ids(v['manual-checks'] ?? '') as ManualCheckId[];
    if (checks.some(id => !manualCheckIds.includes(id))) throw new Error(`--manual-checks must contain: ${manualCheckIds.join(',')}`);
    return submitRelease({ account: acc, appId: a.app, versionId: a.version, versionString: a['version-string'], manualChecks: checks,
      productVersions: { iap: ids(v['iap-version-ids'] ?? ''), subscription: ids(v['subscription-version-ids'] ?? ''), subscriptionGroup: ids(v['subscription-group-version-ids'] ?? '') } }, screenshotClient(acc));
  },
  'release-publish': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'version-string');
    const acc = account();
    return publishRelease({ account: acc, appId: a.app, versionId: a.version, versionString: a['version-string'] }, screenshotClient(acc));
  },
  'iap-create': async (v, { account }) => {
    const a = required(v, 'app', 'product-id', 'name', 'type');
    const acc = account();
    return createIap({ account: acc, appId: a.app, productId: a['product-id'], name: a.name, type: a.type }, screenshotClient(acc));
  },
  'subscription-group-create': async (v, { account }) => {
    const a = required(v, 'app', 'name');
    const acc = account();
    return createSubscriptionGroup({ account: acc, appId: a.app, referenceName: a.name }, screenshotClient(acc));
  },
  'subscription-create': async (v, { account }) => {
    const a = required(v, 'app', 'group', 'product-id', 'name', 'period');
    const acc = account();
    return createSubscription({ account: acc, appId: a.app, groupId: a.group, productId: a['product-id'], name: a.name, period: a.period, groupLevel: v['group-level'] === undefined ? undefined : Number(v['group-level']) }, screenshotClient(acc));
  },
  'product-localize': async (v, { account }) => {
    const a = required(v, 'app', 'locale', 'name');
    if (!!v.iap === !!v.subscription) throw new Error('Pass exactly one of --iap or --subscription.');
    const acc = account();
    return localizeProduct({ account: acc, appId: a.app, kind: v.iap ? 'iap' : 'subscription', productId: (v.iap ?? v.subscription)!, locale: a.locale, name: a.name, description: v.description }, screenshotClient(acc));
  },
  'product-version-create': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product');
    if (!['iap', 'subscription', 'subscription-group'].includes(a.kind)) throw new Error('--kind must be iap, subscription or subscription-group.');
    const acc = account();
    return createProductVersion({ account: acc, appId: a.app, kind: a.kind as ProductKind, productId: a.product }, screenshotClient(acc));
  },
  'product-version-localize': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product', 'version', 'locale', 'name');
    if (!['iap', 'subscription', 'subscription-group'].includes(a.kind)) throw new Error('--kind must be iap, subscription or subscription-group.');
    const acc = account();
    return localizeProductVersion({ account: acc, appId: a.app, kind: a.kind as ProductKind, productId: a.product, versionId: a.version, locale: a.locale,
      name: a.name, description: v.description, customAppName: v['custom-app-name'] }, screenshotClient(acc));
  },
  'product-version-image-upload': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product', 'version', 'file');
    if (a.kind !== 'iap' && a.kind !== 'subscription') throw new Error('--kind must be iap or subscription.');
    const acc = account();
    return uploadProductVersionImage({ account: acc, appId: a.app, kind: a.kind, productId: a.product, versionId: a.version, filePath: a.file }, screenshotClient(acc));
  },
  'app-price-set': async (v, { account }) => {
    const a = required(v, 'app', 'territory', 'price');
    const acc = account();
    return setAppPrice({ account: acc, appId: a.app, territory: a.territory, price: a.price, startDate: v['start-date'], execute: v.execute === true }, screenshotClient(acc));
  },
  'iap-price-set': async (v, { account }) => {
    const a = required(v, 'app', 'iap', 'territory', 'price');
    const acc = account();
    return setIapPrice({ account: acc, appId: a.app, iapId: a.iap, territory: a.territory, price: a.price, startDate: v['start-date'], execute: v.execute === true }, screenshotClient(acc));
  },
  'subscription-price-set': async (v, { account }) => {
    const a = required(v, 'app', 'subscription', 'territory', 'price');
    const acc = account();
    return setSubscriptionPrice({ account: acc, appId: a.app, subscriptionId: a.subscription, territory: a.territory, price: a.price, startDate: v['start-date'], preserveCurrentPrice: v['preserve-current-price'] === true, execute: v.execute === true }, screenshotClient(acc));
  },
  'sales-download': async (v, { account }) => {
    const a = required(v, 'vendor', 'type', 'subtype', 'frequency', 'from', 'to', 'out');
    return downloadSales({ vendorNumber: a.vendor, reportType: a.type, reportSubType: a.subtype, frequency: a.frequency, from: a.from, to: a.to, out: a.out, version: v['report-version'] }, screenshotClient(account()));
  },
  'finance-download': async (v, { account }) => {
    const a = required(v, 'vendor', 'type', 'region-code', 'from', 'to', 'out');
    return downloadFinance({ vendorNumber: a.vendor, reportType: a.type, regionCode: a['region-code'], from: a.from, to: a.to, out: a.out }, screenshotClient(account()));
  },
  'intro-offer-set': async (v, { account }) => {
    const a = required(v, 'app', 'subscription', 'territory', 'offer-mode', 'duration', 'periods');
    const acc = account();
    return setIntroOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, territory: a.territory, offerMode: a['offer-mode'], duration: a.duration,
      numberOfPeriods: Number(a.periods), price: v.price, startDate: v['start-date'], endDate: v['end-date'], replace: v.replace === true, execute: v.execute === true }, screenshotClient(acc));
  },
  'product-availability-set': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product');
    if ((v.all === true) === !!v.territories) throw new Error('Pass exactly one of --territories or --all.');
    const acc = account();
    return extras.setProductAvailability({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, territories: v.all ? 'all' : ids(v.territories!), availableInNewTerritories: v['new-territories'] === true, execute: v.execute === true }, screenshotClient(acc));
  },
  'promo-offer-create': async (v, { account }) => {
    const a = required(v, 'app', 'subscription', 'name', 'offer-code', 'offer-mode', 'duration', 'periods');
    const acc = account();
    return extras.createPromotionalOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, name: a.name, offerCode: a['offer-code'], offerMode: a['offer-mode'], duration: a.duration, numberOfPeriods: Number(a.periods), prices: extras.parsePrices(v.prices), execute: v.execute === true }, screenshotClient(acc));
  },
  'promo-offer-delete': async (v, { account }) => { const a = required(v, 'app', 'subscription', 'offer'); const acc = account(); return extras.deletePromotionalOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, offerId: a.offer }, screenshotClient(acc)); },
  'offer-code-create': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product', 'name', 'eligibility');
    const acc = account();
    return extras.createOfferCode({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, name: a.name, eligibility: ids(a.eligibility), prices: extras.parsePrices(v.prices),
      offerEligibility: v['offer-eligibility'], offerMode: v['offer-mode'], duration: v.duration, numberOfPeriods: v.periods === undefined ? undefined : Number(v.periods), execute: v.execute === true }, screenshotClient(acc));
  },
  'offer-code-activate': async (v, { account }) => { const a = required(v, 'app', 'kind', 'product', 'offer-code'); const acc = account(); return extras.setOfferCodeActive({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, offerCodeId: a['offer-code'], active: true }, screenshotClient(acc)); },
  'offer-code-deactivate': async (v, { account }) => { const a = required(v, 'app', 'kind', 'product', 'offer-code'); const acc = account(); return extras.setOfferCodeActive({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, offerCodeId: a['offer-code'], active: false }, screenshotClient(acc)); },
  'offer-codes-generate': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product', 'offer-code', 'count', 'expires', 'out');
    const acc = account();
    return extras.generateOneTimeCodes({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, offerCodeId: a['offer-code'], count: Number(a.count), expires: a.expires, environment: v.environment, out: a.out, execute: v.execute === true }, screenshotClient(acc));
  },
  'offer-custom-code-create': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product', 'offer-code', 'custom-code', 'count');
    const acc = account();
    return extras.createCustomCode({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, offerCodeId: a['offer-code'], customCode: a['custom-code'], count: Number(a.count), expires: v.expires }, screenshotClient(acc));
  },
  'promoted-purchase-set': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'product');
    const acc = account();
    return extras.setPromotedPurchase({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, visibleForAllUsers: yesNo(v['visible-all'], '--visible-all'), enabled: yesNo(v.enabled, '--enabled') }, screenshotClient(acc));
  },
  'promoted-purchase-delete': async (v, { account }) => { const a = required(v, 'app', 'promoted'); const acc = account(); return extras.deletePromotedPurchase({ account: acc, appId: a.app, promotedPurchaseId: a.promoted }, screenshotClient(acc)); },
  'product-review-screenshot-upload': async (v, { account }) => { const a = required(v, 'app', 'kind', 'product', 'file'); const acc = account(); return extras.uploadProductReviewScreenshot({ account: acc, appId: a.app, kind: kindOf(a.kind), productId: a.product, filePath: a.file }, screenshotClient(acc)); },
  'sandbox-tester-update': async (v, { account }) => { const a = required(v, 'tester'); return extras.updateSandboxTester({ account: account(), testerId: a.tester, territory: v.territory, interruptPurchases: yesNo(v['interrupt-purchases'], '--interrupt-purchases'), renewalRate: v['renewal-rate'] }, screenshotClient(account())); },
  'sandbox-history-clear': async (v, { account }) => { const a = required(v, 'testers'); return extras.clearSandboxHistory({ account: account(), testerIds: ids(a.testers) }, screenshotClient(account())); },
  'cpp-create': async (v, { account }) => { const a = required(v, 'app', 'name'); const acc = account(); return marketing.createCustomPage({ account: acc, appId: a.app, name: a.name, deepLink: v['deep-link'] }, screenshotClient(acc)); },
  'cpp-update': async (v, { account }) => { const a = required(v, 'app', 'page'); const acc = account(); return marketing.updateCustomPage({ account: acc, appId: a.app, pageId: a.page, name: v.name, visible: yesNo(v.visible, '--visible') }, screenshotClient(acc)); },
  'cpp-delete': async (v, { account }) => { const a = required(v, 'app', 'page'); const acc = account(); return marketing.deleteCustomPage({ account: acc, appId: a.app, pageId: a.page }, screenshotClient(acc)); },
  'cpp-localize': async (v, { account }) => { const a = required(v, 'app', 'page-version', 'locale'); const acc = account(); return marketing.localizeCustomPage({ account: acc, appId: a.app, versionId: a['page-version'], locale: a.locale, promotionalText: v['promotional-text'] }, screenshotClient(acc)); },
  'event-create': async (v, { account }) => { const a = required(v, 'app', 'name'); const acc = account(); return marketing.createEvent({ account: acc, appId: a.app, referenceName: a.name, ...eventFields(v) }, screenshotClient(acc)); },
  'event-update': async (v, { account }) => { const a = required(v, 'app', 'event'); const acc = account(); return marketing.updateEvent({ account: acc, appId: a.app, eventId: a.event, referenceName: v.name, ...eventFields(v) }, screenshotClient(acc)); },
  'event-delete': async (v, { account }) => { const a = required(v, 'app', 'event'); const acc = account(); return marketing.deleteEvent({ account: acc, appId: a.app, eventId: a.event }, screenshotClient(acc)); },
  'event-localize': async (v, { account }) => { const a = required(v, 'app', 'event', 'locale'); const acc = account(); return marketing.localizeEvent({ account: acc, appId: a.app, eventId: a.event, locale: a.locale, name: v['event-name'], shortDescription: v['short-description'], longDescription: v['long-description'] }, screenshotClient(acc)); },
  'experiment-create': async (v, { account }) => { const a = required(v, 'app', 'name', 'platform', 'traffic'); const acc = account(); return marketing.createExperiment({ account: acc, appId: a.app, name: a.name, platform: a.platform, trafficProportion: Number(a.traffic) }, screenshotClient(acc)); },
  'experiment-update': async (v, { account }) => { const a = required(v, 'app', 'experiment'); const acc = account(); return marketing.updateExperiment({ account: acc, appId: a.app, experimentId: a.experiment, name: v.name, trafficProportion: v.traffic === undefined ? undefined : Number(v.traffic), started: yesNo(v.started, '--started') }, screenshotClient(acc)); },
  'treatment-create': async (v, { account }) => { const a = required(v, 'app', 'experiment', 'name'); const acc = account(); return marketing.createTreatment({ account: acc, appId: a.app, experimentId: a.experiment, name: a.name, appIconName: v['icon-name'] }, screenshotClient(acc)); },
  'treatment-localize': async (v, { account }) => { const a = required(v, 'app', 'treatment', 'locale'); const acc = account(); return marketing.localizeTreatment({ account: acc, appId: a.app, treatmentId: a.treatment, locale: a.locale }, screenshotClient(acc)); },
  'marketing-place': async (v, { account }) => {
    const a = required(v, 'app', 'target', 'localization', 'placement-type');
    if (!!v.image === !!v.video) throw new Error('Pass exactly one of --image or --video.');
    const acc = account();
    return marketing.placeMarketingAsset({ account: acc, appId: a.app, target: a.target as marketing.MarketingTarget, localizationId: a.localization, kind: v.image ? 'image' : 'video', assetId: (v.image ?? v.video)!, placementType: a['placement-type'], placementGroup: v['placement-group'] }, screenshotClient(acc));
  },
  'marketing-order': async (v, { account }) => {
    const a = required(v, 'app', 'target', 'localization', 'placement-group', 'order');
    if (a.target !== 'cpp' && a.target !== 'experiment') throw new Error('--target must be cpp or experiment.');
    const acc = account();
    return marketing.orderMarketingAssets({ account: acc, appId: a.app, target: a.target, localizationId: a.localization, placementGroup: a['placement-group'], placementIds: ids(a.order) }, screenshotClient(acc));
  },
  'marketing-submit': async (v, { account }) => { const a = required(v, 'app', 'kind', 'id'); const acc = account(); return marketing.submitMarketing({ account: acc, appId: a.app, kind: a.kind as marketing.MarketingTarget, id: a.id }, screenshotClient(acc)); },
  'user-invite': async (v, { account }) => {
    const a = required(v, 'email', 'first-name', 'last-name', 'roles');
    return team.inviteUser({ account: account(), email: a.email, firstName: a['first-name'], lastName: a['last-name'], ...access(v), roles: ids(a.roles), provisioningAllowed: yesNo(v.provisioning, '--provisioning'), execute: v.execute === true }, screenshotClient(account()));
  },
  'user-update': async (v, { account }) => { const a = required(v, 'user'); return team.updateUser({ account: account(), userId: a.user, ...access(v), provisioningAllowed: yesNo(v.provisioning, '--provisioning'), execute: v.execute === true }, screenshotClient(account())); },
  'user-remove': async (v, { account }) => { const a = required(v, 'user'); return team.removeUser({ account: account(), userId: a.user, execute: v.execute === true }, screenshotClient(account())); },
  'invitation-cancel': async (v, { account }) => { const a = required(v, 'invitation'); return team.cancelInvitation({ account: account(), invitationId: a.invitation }, screenshotClient(account())); },
  'device-register': async (v, { account }) => { const a = required(v, 'name', 'udid', 'platform'); return team.registerDevice({ account: account(), name: a.name, udid: a.udid, platform: a.platform }, screenshotClient(account())); },
  'device-update': async (v, { account }) => { const a = required(v, 'device'); return team.updateDevice({ account: account(), deviceId: a.device, name: v.name, status: v.status }, screenshotClient(account())); },
  'capability-enable': async (v, { account }) => { const a = required(v, 'bundle', 'capability'); return team.setCapability({ account: account(), bundleId: a.bundle, capability: a.capability, enabled: true }, screenshotClient(account())); },
  'capability-disable': async (v, { account }) => { const a = required(v, 'bundle', 'capability'); return team.setCapability({ account: account(), bundleId: a.bundle, capability: a.capability, enabled: false }, screenshotClient(account())); },
  'certificate-create': async (v, { account }) => { const a = required(v, 'type', 'csr', 'out'); return team.createCertificate({ account: account(), type: a.type, csrPath: a.csr, out: a.out, execute: v.execute === true }, screenshotClient(account())); },
  'certificate-revoke': async (v, { account }) => { const a = required(v, 'certificate'); return team.revokeCertificate({ account: account(), certificateId: a.certificate, execute: v.execute === true }, screenshotClient(account())); },
  'profile-create': async (v, { account }) => {
    const a = required(v, 'name', 'type', 'bundle', 'certificates', 'out');
    if (v.devices && v['all-devices']) throw new Error('Pass --devices or --all-devices, not both.');
    return team.createProfile({ account: account(), name: a.name, type: a.type, bundleId: a.bundle, certificateIds: ids(a.certificates), deviceIds: v['all-devices'] ? 'all' : v.devices ? ids(v.devices) : undefined, out: a.out }, screenshotClient(account()));
  },
  'profile-download': async (v, { account }) => { const a = required(v, 'profile', 'out'); return team.downloadProfile({ profileId: a.profile, out: a.out }, screenshotClient(account())); },
  'profile-delete': async (v, { account }) => { const a = required(v, 'profile'); return team.deleteProfile({ account: account(), profileId: a.profile }, screenshotClient(account())); },
  'gc-enable': async (v, { account }) => { const a = required(v, 'app'); const acc = account(); return gc.enableGameCenter({ account: acc, appId: a.app, versionId: v.version }, screenshotClient(acc)); },
  'gc-create': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'vendor-id', 'name');
    const acc = account();
    return gc.createItem({ account: acc, appId: a.app, kind: gcKind(a.kind), vendorIdentifier: a['vendor-id'], referenceName: a.name, leaderboardId: v.leaderboard, ...gcFields(v) }, screenshotClient(acc));
  },
  'gc-update': async (v, { account }) => { const a = required(v, 'app', 'kind', 'id'); const acc = account(); return gc.updateItem({ account: acc, appId: a.app, kind: gcKind(a.kind), id: a.id, referenceName: v.name, archived: yesNo(v.archived, '--archived'), ...gcFields(v) }, screenshotClient(acc)); },
  'gc-version-create': async (v, { account }) => { const a = required(v, 'app', 'kind', 'id'); const acc = account(); return gc.createItemVersion({ account: acc, appId: a.app, kind: gcKind(a.kind), id: a.id }, screenshotClient(acc)); },
  'gc-localize': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'id', 'locale');
    const acc = account();
    return gc.localizeItem({ account: acc, appId: a.app, kind: gcKind(a.kind), id: a.id, locale: a.locale, text: { name: v.title, description: v.description, beforeEarnedDescription: v.before, afterEarnedDescription: v.after,
      formatterSuffix: v.suffix, formatterSuffixSingular: v['suffix-singular'], formatterOverride: v['formatter-override'] } }, screenshotClient(acc));
  },
  'gc-image-upload': async (v, { account }) => { const a = required(v, 'app', 'kind', 'id', 'file'); const acc = account(); return gc.uploadItemImage({ account: acc, appId: a.app, kind: gcKind(a.kind), id: a.id, locale: v.locale, filePath: a.file }, screenshotClient(acc)); },
  'gc-submit': async (v, { account }) => { const a = required(v, 'app', 'kind', 'id'); const acc = account(); return gc.submitItem({ account: acc, appId: a.app, kind: gcKind(a.kind), id: a.id, appVersionId: v['app-version'] }, screenshotClient(acc)); },
  'gc-set-members': async (v, { account }) => { const a = required(v, 'app', 'set', 'leaderboards'); const acc = account(); return gc.setLeaderboardSetMembers({ account: acc, appId: a.app, setId: a.set, leaderboardIds: ids(a.leaderboards) }, screenshotClient(acc)); },
  'gc-link-activity': async (v, { account }) => {
    const a = required(v, 'app', 'kind', 'id', 'activity');
    if (a.kind !== 'leaderboard' && a.kind !== 'achievement') throw new Error('--kind must be leaderboard or achievement.');
    const acc = account();
    return gc.linkToActivity({ account: acc, appId: a.app, kind: a.kind, id: a.id, activityId: a.activity === 'none' ? null : a.activity }, screenshotClient(acc));
  },
  'gc-default-leaderboard': async (v, { account }) => { const a = required(v, 'app', 'leaderboard'); const acc = account(); return gc.setDefaultLeaderboard({ account: acc, appId: a.app, leaderboardId: a.leaderboard }, screenshotClient(acc)); },
  'gc-group-create': async (v, { account }) => { const a = required(v, 'name'); return gc.createGroup({ account: account(), referenceName: a.name }, screenshotClient(account())); },
  'gc-group-join': async (v, { account }) => { const a = required(v, 'app', 'group'); const acc = account(); return gc.joinGroup({ account: acc, appId: a.app, groupId: a.group, execute: v.execute === true }, screenshotClient(acc)); },
  'gc-match-ruleset-create': async (v, { account }) => { const a = required(v, 'name', 'min-players', 'max-players'); return gc.createRuleSet({ account: account(), referenceName: a.name, minPlayers: Number(a['min-players']), maxPlayers: Number(a['max-players']), ruleLanguageVersion: v['language-version'] === undefined ? undefined : Number(v['language-version']) }, screenshotClient(account())); },
  'gc-match-rule-create': async (v, { account }) => { const a = required(v, 'ruleset', 'name', 'type', 'expression', 'description'); return gc.createRule({ account: account(), ruleSetId: a.ruleset, referenceName: a.name, type: a.type, expression: a.expression, description: a.description, weight: v.weight === undefined ? undefined : Number(v.weight) }, screenshotClient(account())); },
  'gc-match-team-create': async (v, { account }) => { const a = required(v, 'ruleset', 'name', 'min-players', 'max-players'); return gc.createTeam({ account: account(), ruleSetId: a.ruleset, referenceName: a.name, minPlayers: Number(a['min-players']), maxPlayers: Number(a['max-players']) }, screenshotClient(account())); },
  'gc-match-queue-create': async (v, { account }) => { const a = required(v, 'ruleset', 'name'); return gc.createQueue({ account: account(), ruleSetId: a.ruleset, referenceName: a.name, classicBundleIds: v['bundle-ids'] === undefined ? undefined : ids(v['bundle-ids']) }, screenshotClient(account())); },
  'ci-build-start': async (v, { account }) => {
    const a = required(v, 'app', 'workflow');
    const acc = account();
    return ci.startBuild({ account: acc, appId: a.app, workflowId: a.workflow, branch: v.branch, tag: v.tag, pullRequest: v['pull-request'] === undefined ? undefined : Number(v['pull-request']), rebuildOf: v.rebuild, clean: v.clean, execute: v.execute === true }, screenshotClient(acc));
  },
  'ci-build-wait': async (v, { account }) => {
    const a = required(v, 'app', 'build-run');
    const minutes = Number(v['timeout-minutes'] ?? 90); const seconds = Number(v['interval-seconds'] ?? 30);
    if (!(minutes >= 1 && minutes <= 24 * 60) || !(seconds >= 10 && seconds <= 600)) throw new Error('--timeout-minutes 1-1440, --interval-seconds 10-600.');
    const result = await ci.waitForBuildRun({ appId: a.app, buildRunId: a['build-run'] }, screenshotClient(account()), { timeoutMs: minutes * 60_000, intervalMs: seconds * 1000, onProgress: line => console.error(`${new Date().toISOString()} ${line}`) });
    if (!result.ok) process.exitCode = 1;
    return result;
  },
  'ci-build-report': async (v, { account }) => { const a = required(v, 'app', 'build-run'); return ci.reportBuildRun({ appId: a.app, buildRunId: a['build-run'] }, screenshotClient(account())); },
  'ci-artifacts': async (v, { account }) => { const a = required(v, 'app', 'build-run'); return ci.listArtifacts({ appId: a.app, buildRunId: a['build-run'] }, screenshotClient(account())); },
  'ci-artifact-download': async (v, { account }) => { const a = required(v, 'app', 'build-run', 'artifact', 'out'); return ci.downloadArtifact({ appId: a.app, buildRunId: a['build-run'], artifactId: a.artifact, out: a.out }, screenshotClient(account())); },
  'ci-workflow-enable': async (v, { account }) => { const a = required(v, 'app', 'workflow'); const acc = account(); return ci.setWorkflowEnabled({ account: acc, appId: a.app, workflowId: a.workflow, enabled: true }, screenshotClient(acc)); },
  'ci-workflow-disable': async (v, { account }) => { const a = required(v, 'app', 'workflow'); const acc = account(); return ci.setWorkflowEnabled({ account: acc, appId: a.app, workflowId: a.workflow, enabled: false }, screenshotClient(acc)); },
  'eula-set': async (v, { account }) => {
    const a = required(v, 'app', 'file');
    if ((v.all === true) === !!v.territories) throw new Error('Pass exactly one of --territories or --all.');
    const acc = account();
    return listing.setEula({ account: acc, appId: a.app, filePath: a.file, territories: v.all ? 'all' : ids(v.territories!), execute: v.execute === true }, screenshotClient(acc));
  },
  'eula-remove': async (v, { account }) => { const a = required(v, 'app'); const acc = account(); return listing.removeEula({ account: acc, appId: a.app, execute: v.execute === true }, screenshotClient(acc)); },
  'accessibility-set': async (v, { account }) => { const a = required(v, 'app', 'device'); const acc = account(); return listing.setAccessibility({ account: acc, appId: a.app, device: a.device, supports: ids(v.supports ?? ''), publish: v['publish-labels'] === true }, screenshotClient(acc)); },
  'routing-coverage-upload': async (v, { account }) => { const a = required(v, 'app', 'version', 'file'); const acc = account(); return listing.uploadRoutingCoverage({ account: acc, appId: a.app, versionId: a.version, filePath: a.file }, screenshotClient(acc)); },
  'cpp-keywords-set': async (v, { account }) => { const a = required(v, 'app', 'localization', 'keywords'); const acc = account(); return listing.setCustomPageKeywords({ account: acc, appId: a.app, localizationId: a.localization, keywords: ids(a.keywords) }, screenshotClient(acc)); },
  'winback-create': async (v, { account }) => {
    const a = required(v, 'app', 'subscription', 'name', 'offer', 'offer-mode', 'duration', 'periods', 'paid-months', 'lapsed-min', 'lapsed-max', 'start-date', 'priority', 'prices');
    const acc = account();
    return extras.createWinBackOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, referenceName: a.name, offerId: a.offer, offerMode: a['offer-mode'], duration: a.duration, periodCount: Number(a.periods),
      paidMonths: Number(a['paid-months']), lapsedMin: Number(a['lapsed-min']), lapsedMax: Number(a['lapsed-max']), waitMonths: numberOrUndefined(v['wait-months'], '--wait-months'),
      startDate: a['start-date'], endDate: v['end-date'], priority: a.priority, promoted: yesNo(v.promote, '--promote') ?? false, prices: extras.parsePrices(a.prices), execute: v.execute === true }, screenshotClient(acc));
  },
  'winback-update': async (v, { account }) => {
    const a = required(v, 'app', 'subscription', 'offer');
    const acc = account();
    return extras.updateWinBackOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, offerId: a.offer, startDate: v['start-date'], endDate: v['end-date'], priority: v.priority,
      promoted: yesNo(v.promote, '--promote'), paidMonths: numberOrUndefined(v['paid-months'], '--paid-months'), waitMonths: numberOrUndefined(v['wait-months'], '--wait-months') }, screenshotClient(acc));
  },
  'winback-delete': async (v, { account }) => { const a = required(v, 'app', 'subscription', 'offer'); const acc = account(); return extras.deleteWinBackOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, offerId: a.offer }, screenshotClient(acc)); },
  'retention-message-create': async (v, { account }) => { const a = required(v, 'app', 'name'); const acc = account(); return extras.createRetentionMessage({ account: acc, appId: a.app, referenceName: a.name }, screenshotClient(acc)); },
  'retention-localize': async (v, { account }) => { const a = required(v, 'app', 'message', 'locale'); const acc = account(); return extras.localizeRetentionMessage({ account: acc, appId: a.app, messageId: a.message, locale: a.locale, header: v.header, body: v.body }, screenshotClient(acc)); },
  'retention-attach': async (v, { account }) => { const a = required(v, 'app', 'message', 'subscriptions'); const acc = account(); return extras.attachRetentionMessage({ account: acc, appId: a.app, messageId: a.message, subscriptionIds: ids(a.subscriptions) }, screenshotClient(acc)); },
  'retention-submit': async (v, { account }) => {
    const a = required(v, 'app', 'message');
    const acc = account(); const api = screenshotClient(acc);
    const versionId = await extras.retentionVersionForReview(api, a.app, a.message);
    return { versionId, ...await submitForReview({ account: acc, appId: a.app, items: [{ relation: 'retentionMessageVersion', id: versionId }] }, api) };
  },
  'retention-delete': async (v, { account }) => { const a = required(v, 'app', 'message'); const acc = account(); return extras.deleteRetentionMessage({ account: acc, appId: a.app, messageId: a.message }, screenshotClient(acc)); },
  'appclip-default-set': async (v, { account }) => { const a = required(v, 'app', 'clip', 'action'); const acc = account(); return listing.setClipDefaultExperience({ account: acc, appId: a.app, clipId: a.clip, action: a.action, versionId: v.version }, screenshotClient(acc)); },
  'appclip-localize': async (v, { account }) => { const a = required(v, 'app', 'experience', 'locale', 'subtitle'); const acc = account(); return listing.localizeClipExperience({ account: acc, appId: a.app, experienceId: a.experience, locale: a.locale, subtitle: a.subtitle }, screenshotClient(acc)); },
  'appclip-header-upload': async (v, { account }) => { const a = required(v, 'app', 'experience', 'locale', 'file'); const acc = account(); return listing.uploadClipHeader({ account: acc, appId: a.app, experienceId: a.experience, locale: a.locale, filePath: a.file }, screenshotClient(acc)); },
  'appclip-review-urls': async (v, { account }) => { const a = required(v, 'app', 'experience', 'urls'); const acc = account(); return listing.setClipReviewUrls({ account: acc, appId: a.app, experienceId: a.experience, urls: ids(a.urls) }, screenshotClient(acc)); },
  'asset-pack-create': async (v, { account }) => { const a = required(v, 'app', 'identifier'); const acc = account(); return listing.createAssetPack({ account: acc, appId: a.app, identifier: a.identifier }, screenshotClient(acc)); },
  'asset-pack-upload': async (v, { account }) => { const a = required(v, 'app', 'asset-pack', 'file'); const acc = account(); return listing.uploadAssetPackVersion({ account: acc, appId: a.app, assetPackId: a['asset-pack'], archivePath: a.file, manifestPath: v.manifest, execute: v.execute === true }, screenshotClient(acc)); },
  'asset-pack-submit': async (v, { account }) => { const a = required(v, 'app', 'asset-pack', 'pack-version'); const acc = account(); return listing.submitAssetPackVersion({ account: acc, appId: a.app, assetPackId: a['asset-pack'], versionId: a['pack-version'] }, screenshotClient(acc)); },
  'alt-key-set': async (v, { account }) => { const a = required(v, 'app', 'public-key'); const acc = account(); return listing.setDistributionKey({ account: acc, appId: a.app, publicKeyPath: a['public-key'] }, screenshotClient(acc)); },
  'alt-domain-add': async (v, { account }) => { const a = required(v, 'domain', 'name'); return listing.addDistributionDomain({ account: account(), domain: a.domain, referenceName: a.name }, screenshotClient(account())); },
  'marketplace-search-set': async (v, { account }) => { const a = required(v, 'app', 'catalog-url'); const acc = account(); return listing.setMarketplaceSearch({ account: acc, appId: a.app, catalogUrl: a['catalog-url'] }, screenshotClient(acc)); },
  'alt-package-create': async (v, { account }) => { const a = required(v, 'app', 'version'); const acc = account(); return listing.createDistributionPackage({ account: acc, appId: a.app, versionId: a.version }, screenshotClient(acc)); },
  'intro-offer-delete': async (v, { account }) => { const a = required(v, 'app', 'subscription', 'offer'); const acc = account(); return deleteIntroOffer({ account: acc, appId: a.app, subscriptionId: a.subscription, offerId: a.offer }, screenshotClient(acc)); },
  'analytics-request': async (v, { account }) => {
    const a = required(v, 'app');
    const access = v.access ?? 'ONGOING';
    if (access !== 'ONGOING' && access !== 'ONE_TIME_SNAPSHOT') throw new Error('--access must be ONGOING or ONE_TIME_SNAPSHOT.');
    const acc = account();
    return requestAnalytics({ account: acc, appId: a.app, accessType: access }, screenshotClient(acc));
  },
  'analytics-download': async (v, { account }) => {
    const a = required(v, 'app', 'report-name', 'granularity', 'out');
    return downloadAnalytics({ appId: a.app, reportName: a['report-name'], granularity: a.granularity, category: v.category, from: v.from, to: v.to, out: a.out }, screenshotClient(account()));
  },
  'webhook-create': async (v, { account }) => {
    const a = required(v, 'app', 'name', 'url', 'events');
    const acc = account();
    return createWebhook({ account: acc, appId: a.app, name: a.name, url: a.url, events: ids(a.events), secret: webhookSecret() }, screenshotClient(acc));
  },
  'webhook-enable': async (v, { account }) => { const a = required(v, 'app', 'webhook'); const acc = account(); return setWebhookEnabled({ account: acc, appId: a.app, webhookId: a.webhook, enabled: true }, screenshotClient(acc)); },
  'webhook-disable': async (v, { account }) => { const a = required(v, 'app', 'webhook'); const acc = account(); return setWebhookEnabled({ account: acc, appId: a.app, webhookId: a.webhook, enabled: false }, screenshotClient(acc)); },
  'webhook-ping': async (v, { account }) => { const a = required(v, 'app', 'webhook'); const acc = account(); return pingWebhook({ account: acc, appId: a.app, webhookId: a.webhook }, screenshotClient(acc)); },
  'webhook-delete': async (v, { account }) => { const a = required(v, 'app', 'webhook'); const acc = account(); return deleteWebhook({ account: acc, appId: a.app, webhookId: a.webhook }, screenshotClient(acc)); },
  'webhook-redeliver': async (v, { account }) => { const a = required(v, 'app', 'webhook', 'delivery'); const acc = account(); return redeliverWebhook({ account: acc, appId: a.app, webhookId: a.webhook, deliveryId: a.delivery }, screenshotClient(acc)); },
  'smoke-read': async (v, { service }) => {
    const report = await smokeRead(createServer(service), { account: required(v, 'account').account, appId: v.app });
    if (v.out) {
      if (!isAbsolute(v.out)) throw new Error('--out must be an absolute path.');
      writeFile(v.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    return report;
  },
  audit: async (v, { store }) => store.auditLog(Math.min(Math.max(Number(v.limit ?? 100) || 100, 1), 1000)),
  plan: async (v, { store }) => store.get(required(v, 'plan').plan),
  apply: async (v, { service }) => {
    const a = required(v, 'plan');
    if (!v.digest) throw new Error('--digest is required; inspect the saved plan first.');
    return service.apply(a.plan, v.digest);
  },
};

/** Commands that change Apple state, with the capability each needs. Dry runs are checked separately. */
const WRITES: Record<string, Capability> = {
  apply: 'upload', 'api-apply': 'admin', 'bundle-id-create': 'admin', 'app-update': 'upload', 'app-info-set': 'upload', 'app-category-set': 'upload', 'age-rating-set': 'upload', 'availability-set': 'commercial',
  'version-create': 'upload', 'version-update': 'upload', 'version-build-set': 'upload', 'build-compliance': 'upload', 'version-localize': 'upload', 'metadata-sync': 'upload', 'screenshots-sync': 'upload', 'preview-upload': 'upload', 'preview-place': 'upload',
  'encryption-declaration-create': 'upload', 'encryption-document-upload': 'upload', 'build-encryption-attach': 'upload',
  'review-detail-set': 'upload', 'review-attachment-upload': 'upload', 'review-cancel': 'review', 'review-item-remove': 'review', 'phased-release': 'release',
  'beta-info-set': 'upload', 'beta-notes-set': 'upload', 'beta-review-detail-set': 'upload', 'beta-submit': 'review', 'beta-group-create': 'admin', 'beta-tester-add': 'admin', 'beta-tester-remove': 'admin', 'review-reply': 'admin',
  'asset-upload': 'upload', 'asset-resume': 'upload', 'asset-order': 'upload', 'asset-cleanup': 'upload',
  'screenshot-set-create': 'upload', 'screenshot-upload': 'upload', 'screenshot-resume': 'upload', 'screenshot-order': 'upload',
  'build-upload': 'upload', 'build-resume': 'upload', 'build-cancel': 'upload', 'testflight-distribute': 'upload',
  'creative-upload': 'upload', 'creative-resume': 'upload', 'creative-place': 'upload', 'creative-remove': 'upload',
  'creative-submit': 'review', 'release-submit': 'review', 'release-publish': 'release',
  'iap-create': 'commercial', 'subscription-group-create': 'commercial', 'subscription-create': 'commercial', 'product-localize': 'commercial',
  'product-version-create': 'commercial', 'product-version-localize': 'commercial', 'product-version-image-upload': 'commercial',
  'app-price-set': 'commercial', 'iap-price-set': 'commercial', 'subscription-price-set': 'commercial', 'intro-offer-set': 'commercial', 'intro-offer-delete': 'commercial', 'product-availability-set': 'commercial', 'promo-offer-create': 'commercial', 'promo-offer-delete': 'commercial', 'offer-code-create': 'commercial', 'offer-code-activate': 'commercial', 'offer-code-deactivate': 'commercial', 'offer-codes-generate': 'commercial', 'offer-custom-code-create': 'commercial', 'promoted-purchase-set': 'commercial', 'promoted-purchase-delete': 'commercial', 'product-review-screenshot-upload': 'upload', 'sandbox-tester-update': 'admin', 'sandbox-history-clear': 'admin', 'cpp-create': 'upload', 'cpp-update': 'upload', 'cpp-delete': 'upload', 'cpp-localize': 'upload', 'event-create': 'upload', 'event-update': 'upload', 'event-delete': 'upload', 'event-localize': 'upload', 'experiment-create': 'upload', 'experiment-update': 'release', 'treatment-create': 'upload', 'treatment-localize': 'upload', 'marketing-place': 'upload', 'marketing-order': 'upload', 'marketing-submit': 'review', 'ci-build-start': 'upload', 'eula-set': 'upload', 'eula-remove': 'upload', 'accessibility-set': 'upload', 'routing-coverage-upload': 'upload', 'cpp-keywords-set': 'upload', 'winback-create': 'commercial', 'winback-update': 'commercial', 'winback-delete': 'commercial', 'retention-message-create': 'commercial', 'retention-localize': 'commercial', 'retention-attach': 'commercial', 'retention-submit': 'review', 'retention-delete': 'commercial', 'appclip-default-set': 'upload', 'appclip-localize': 'upload', 'appclip-header-upload': 'upload', 'appclip-review-urls': 'upload', 'asset-pack-create': 'upload', 'asset-pack-upload': 'upload', 'asset-pack-submit': 'review', 'alt-key-set': 'admin', 'alt-domain-add': 'admin', 'marketplace-search-set': 'admin', 'alt-package-create': 'release', 'ci-workflow-enable': 'admin', 'ci-workflow-disable': 'admin', 'gc-enable': 'upload', 'gc-create': 'upload', 'gc-update': 'upload', 'gc-version-create': 'upload', 'gc-localize': 'upload', 'gc-image-upload': 'upload', 'gc-submit': 'review', 'gc-set-members': 'upload', 'gc-link-activity': 'upload', 'gc-default-leaderboard': 'upload', 'gc-group-create': 'admin', 'gc-group-join': 'admin', 'gc-match-ruleset-create': 'admin', 'gc-match-rule-create': 'admin', 'gc-match-team-create': 'admin', 'gc-match-queue-create': 'admin', 'user-invite': 'admin', 'user-update': 'admin', 'user-remove': 'admin', 'invitation-cancel': 'admin', 'device-register': 'admin', 'device-update': 'admin', 'capability-enable': 'admin', 'capability-disable': 'admin', 'certificate-create': 'admin', 'certificate-revoke': 'admin', 'profile-create': 'admin', 'profile-delete': 'admin',
  'analytics-request': 'admin', 'webhook-create': 'admin', 'webhook-enable': 'admin', 'webhook-disable': 'admin', 'webhook-ping': 'admin', 'webhook-delete': 'admin', 'webhook-redeliver': 'admin',
};
const DRY_RUN_UNLESS_EXECUTE = new Set(['eula-set', 'eula-remove', 'winback-create', 'asset-pack-upload', 'ci-build-start', 'gc-group-join', 'user-invite', 'user-update', 'user-remove', 'certificate-create', 'certificate-revoke', 'product-availability-set', 'promo-offer-create', 'offer-code-create', 'offer-codes-generate', 'intro-offer-set', 'metadata-sync', 'screenshots-sync', 'availability-set', 'asset-cleanup', 'app-price-set', 'iap-price-set', 'subscription-price-set']);

/** Resume and apply commands name a journal entry, not an app; resolve it so audit and lease see the real target. */
function writeTarget(command: string, values: Values, store: PlanStore): { account?: string; appId?: string } {
  const journal = (read: () => { account: string; appId: string }) => { try { return read(); } catch { return { account: values.account, appId: values.app }; } };
  if (command === 'apply' && values.plan) return journal(() => { const { account, appId } = store.get(values.plan!).body; return { account, appId }; });
  if (command === 'api-apply' && values.plan) return journal(() => { const { account, appId } = store.apiPlan(values.plan!).body; return { account, appId }; });
  if (command === 'asset-resume' && values.image) return journal(() => store.asset(values.image!));
  if (command === 'creative-resume' && values.asset) return journal(() => store.creative(values.asset!));
  if (command === 'screenshot-resume' && values.screenshot) return journal(() => store.screenshot(values.screenshot!));
  if (command === 'build-resume' && values.upload) return journal(() => store.buildJob(values.upload!));
  return { account: values.account, appId: values.app };
}
/** Holds the account/app lease for one write. Plan apply manages its own lease per plan. */
async function withLease<T>(config: Config, store: PlanStore, target: { account?: string; appId?: string }, run: () => Promise<T>): Promise<T> {
  const account = config.accounts.find(a => a.name === target.account);
  if (!account || !target.appId) return run();
  const lease = store.acquireScope(accountIdentity(account), target.appId);
  const beat = setInterval(() => {
    try { store.heartbeat(lease); } catch { console.error('Warning: write lease was lost; another operation may run concurrently.'); }
  }, 60_000);
  try { return await run(); } finally { clearInterval(beat); store.release(lease); }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options });
  const command = positionals[0] ?? 'serve';
  if (command === 'help' || values.help) {
    // `help`, `help <topic|command>`, `<command> --help`; `help all` prints every command.
    const subject = command === 'help' ? positionals[1] : command === 'serve' && !positionals[0] ? undefined : command;
    if (!subject) { console.log(overview()); return; }
    if (subject === 'all') { console.log(allHelp()); return; }
    const topic = findTopic(subject);
    if (!topic) throw new Error(`No help for ${subject}. Run apple-connect-mcp help to see topics.`);
    console.log(topicHelp(topic));
    return;
  }
  const known = ['serve', 'doctor', 'key-setup', 'webhook-listen'].includes(command) || command in commands;
  if (!known || positionals.length > 1) throw new Error('Unknown command. Use --help.');
  if (command === 'key-setup') {
    const a = required(values, 'name', 'p8');
    if (!!values.issuer === (values.individual === true)) throw new Error('Pass exactly one of --issuer or --individual.');
    const configPath = values.config ?? process.env.APPLE_CONNECT_CONFIG;
    if (!configPath) throw new Error('Pass --config or set APPLE_CONNECT_CONFIG; the file is created if missing.');
    console.log(JSON.stringify(setupKey({ name: a.name, issuerId: values.issuer, p8Path: a.p8, keyId: values['key-id'], configPath, allowedAppIds: ids(values['allow-app'] ?? ''), replace: values.replace === true }), null, 2));
    return;
  }
  const config = loadConfig(values.config);
  const store = new PlanStore(config.databasePath);
  const service = new ConnectService(config, store);
  if (command === 'serve') {
    serveStdio(() => createServer(service, values.config ?? process.env.APPLE_CONNECT_CONFIG));
    const close = () => { store.close(); process.exit(0); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    return;
  }
  if (command === 'webhook-listen') {
    const port = Number(values.port ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1-65535.');
    const server = webhookReceiver(webhookSecret(), store);
    server.listen(port, '127.0.0.1', () => console.error(`Listening on http://127.0.0.1:${port}. Expose it through your own HTTPS tunnel.`));
    const close = () => { server.close(); store.close(); process.exit(0); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    return;
  }
  const osUser = userInfo().username;
  const capability = WRITES[command];
  const writes = capability !== undefined && !(DRY_RUN_UNLESS_EXECUTE.has(command) && values.execute !== true);
  try {
    if (command === 'doctor') {
      let failed = false;
      for (const account of config.accounts) {
        try { await service.api(account.name).list('/v1/apps?limit=1', 1); console.log(JSON.stringify({ account: account.name, appsReadAccess: true, readOnly: account.readOnly })); }
        catch (error) { failed = true; console.log(JSON.stringify({ account: account.name, error: error instanceof Error ? error.message : 'Check failed' })); }
      }
      if (failed) process.exitCode = 1;
      return;
    }
    const target = writeTarget(command, values, store);
    const record = (ok: boolean, error?: string) => {
      if (!writes) return;
      // Never let a logging failure read as a failed Apple write.
      try { store.audit({ osUser, command, account: target.account, appId: target.appId, ok, error }); }
      catch { console.error('Warning: this command could not be written to the audit log.'); }
    };
    const account = () => service.account(required(values, 'account').account);
    let result: unknown;
    try {
      if (writes) {
        if (!target.account) throw new Error(command === 'apply' ? '--plan is required.' : '--account required.');
        requireCapability(config, osUser, target.account, capability);
      }
      const run = () => commands[command]!(values, { service, store, account });
      result = writes && command !== 'apply' ? await withLease(config, store, target, run) : await run();
    } catch (error) {
      record(false, error instanceof Error ? error.message.slice(0, 500) : 'failed');
      throw error;
    }
    console.log(JSON.stringify(result, null, 2));
    const partial = (result as { ok?: unknown } | null)?.ok === false;
    record(!partial, partial ? 'Partly failed; see command output.' : undefined);
  } finally { store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
