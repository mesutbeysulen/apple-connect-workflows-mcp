#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { userInfo } from 'node:os';
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
import { createWebhook, deleteWebhook, pingWebhook, redeliverWebhook, setWebhookEnabled, webhookReceiver, webhookSecret } from './webhooks.js';
import { setupKey } from './key-setup.js';
import * as prep from './release-prep.js';
import { readMetadataFile, syncMetadata, syncScreenshots } from './bulk.js';
import { uploadPreview, placePreview } from './creative-assets.js';
import { applyApiPlan } from './api-plans.js';

const HELP = `apple-connect-mcp <command> [--config /absolute/config.json]
  serve                         Start stdio MCP (default)
  doctor                        Check configured accounts against Apple
  plan --plan ID                Print the exact saved plan and digest
  apply --plan ID --digest HASH  Execute this reviewed plan (requires writes enabled)

 Asset Library (App Store Connect API 4.6+, recommended for new screenshots)
  asset-upload --account NAME --app ID --version ID --localization ID --placement-group GROUP --file /absolute/image.png
               [--placement-type APP_SCREENSHOT|IMESSAGE_APP_SCREENSHOT] [--reference-name TEXT]
  asset-resume --account NAME --image ID
  asset-order --account NAME --app ID --version ID --localization ID --placement-group GROUP --order ID1,ID2,...
  asset-cleanup --account NAME --app ID [--older-than-hours 24] [--execute]

 Set up an app for release (the app record itself is created in App Store Connect)
  bundle-id-create --account NAME --identifier com.example.app --name TEXT --platform IOS|MAC_OS|UNIVERSAL
  app-update --account NAME --app ID [--primary-locale tr] [--content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT|USES_THIRD_PARTY_CONTENT]
  app-info-set --account NAME --app ID --locale tr [--name TEXT] [--subtitle TEXT] [--privacy-url URL] [--privacy-choices-url URL] [--privacy-text TEXT]
  app-category-set --account NAME --app ID --primary ID [--primary-sub1 ID] [--primary-sub2 ID] [--secondary ID] [--secondary-sub1 ID] [--secondary-sub2 ID]
  age-rating-set --account NAME --app ID --file /absolute/age-rating.json
  availability-set --account NAME --app ID --territories USA,TUR [--new-territories] [--execute]
  version-create --account NAME --app ID --platform IOS --version-string 1.2.3 [--copyright TEXT] [--release-type MANUAL|AFTER_APPROVAL|SCHEDULED] [--release-date ISO]
  version-update --account NAME --app ID --version ID [--copyright TEXT] [--release-type TYPE] [--release-date ISO] [--version-string 1.2.3]
  version-build-set --account NAME --app ID --version ID --build ID
  build-compliance --account NAME --app ID --build ID --uses-encryption true|false
  encryption-declaration-create --account NAME --app ID --app-description TEXT --proprietary-crypto true|false --third-party-crypto true|false --french-store true|false
  encryption-document-upload --account NAME --app ID --declaration ID --file /absolute/document.pdf
  build-encryption-attach --account NAME --app ID --declaration ID --build ID
  version-localize --account NAME --app ID --version ID --locale tr [--description TEXT] [--keywords TEXT] [--whats-new TEXT] [--promotional-text TEXT] [--support-url URL] [--marketing-url URL]
  metadata-sync --account NAME --app ID --version ID --file /absolute/metadata.json [--execute]
  screenshots-sync --account NAME --app ID --version ID --dir /absolute/shots [--replace] [--execute]
  preview-upload --account NAME --app ID --file /absolute/preview.mp4 [--reference-name TEXT] [--preview-frame 00:00:02:00]
  preview-place --account NAME --app ID --version ID --localization ID --video ID --placement-group GROUP
  review-detail-set --account NAME --app ID --version ID [--first-name X] [--last-name X] [--phone X] [--email X] [--notes X] [--demo-required true|false] [--demo-name X]
                    (test password from APPLE_REVIEW_DEMO_PASSWORD)
  review-attachment-upload --account NAME --app ID --version ID --file /absolute/demo.mov
  review-cancel --account NAME --app ID --submission ID
  review-item-remove --account NAME --app ID --submission ID --item ID
  phased-release --account NAME --app ID --version ID --state INACTIVE|ACTIVE|PAUSED|COMPLETE

 TestFlight setup
  beta-info-set --account NAME --app ID --locale tr [--description TEXT] [--feedback-email X] [--marketing-url URL] [--privacy-url URL]
  beta-notes-set --account NAME --app ID --build ID --locale tr --whats-new TEXT
  beta-review-detail-set --account NAME --app ID [--first-name X] [--last-name X] [--phone X] [--email X] [--notes X] [--demo-required true|false] [--demo-name X]
  beta-submit --account NAME --app ID --build ID
  beta-group-create --account NAME --app ID --name TEXT [--public-link] [--feedback]
  beta-tester-add --account NAME --app ID --group ID --emails a@x.com,b@x.com
  beta-tester-remove --account NAME --app ID --group ID --tester ID

 After release
  review-reply --account NAME --app ID --review ID --text TEXT

 Any other App Store Connect write (needs genericWrites: true; prepare plans with the api_write_plan MCP tool)
  api-plan-show --plan ID
  api-apply --plan ID --digest HASH

 Header and Search Results (creative assets, iOS 27 / iPadOS 27 or later)
  creative-upload --account NAME --app ID --placements header,search --file /absolute/asset.png|.mov
                  [--reference-name TEXT] [--preview-frame 00:00:02:00]
  creative-resume --account NAME --asset ID
  creative-submit --account NAME --app ID [--images ID,...] [--videos ID,...]
  creative-place --account NAME --app ID --version ID --localization ID --placements header,search
                 (--image ID | --video ID) [--placement-group GROUP] [--replace]
  creative-remove --account NAME --app ID --version ID --localization ID --placement ID

 Release
  release-check --account NAME --app ID --version ID [--manual-checks ID1,ID2,...]
  release-submit --account NAME --app ID --version ID --version-string 1.2.3 --manual-checks ID1,ID2,...
                 [--iap-version-ids ID1,ID2,...] [--subscription-version-ids ID1,ID2,...] [--subscription-group-version-ids ID1,ID2,...]
  release-publish --account NAME --app ID --version ID --version-string 1.2.3

 Commercial (price commands preview unless --execute is given)
  iap-create --account NAME --app ID --product-id ID --name TEXT --type CONSUMABLE|NON_CONSUMABLE|NON_RENEWING_SUBSCRIPTION
  subscription-group-create --account NAME --app ID --name TEXT
  subscription-create --account NAME --app ID --group ID --product-id ID --name TEXT --period ONE_MONTH [--group-level 1]
  product-localize --account NAME --app ID (--iap ID | --subscription ID) --locale tr --name TEXT [--description TEXT]
  product-version-create --account NAME --app ID --kind iap|subscription|subscription-group --product ID
  product-version-localize --account NAME --app ID --kind iap|subscription|subscription-group --product ID --version ID --locale en-US --name TEXT [--description TEXT] [--custom-app-name TEXT]
  product-version-image-upload --account NAME --app ID --kind iap|subscription --product ID --version ID --file /absolute/image.png
  intro-offer-set --account NAME --app ID --subscription ID --territory USA --offer-mode FREE_TRIAL|PAY_AS_YOU_GO|PAY_UP_FRONT
                  --duration ONE_WEEK --periods 1 [--price 0.99] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--replace] [--execute]
  intro-offer-delete --account NAME --app ID --subscription ID --offer ID
  app-price-set --account NAME --app ID --territory USA --price 4.99 [--start-date YYYY-MM-DD] [--execute]
  iap-price-set --account NAME --app ID --iap ID --territory USA --price 4.99 [--start-date YYYY-MM-DD] [--execute]
  subscription-price-set --account NAME --app ID --subscription ID --territory USA --price 4.99
                         [--start-date YYYY-MM-DD] [--preserve-current-price] [--execute]

 Reports
  sales-download --account NAME --vendor NUMBER --type SALES --subtype SUMMARY --frequency DAILY --from YYYY-MM-DD --to YYYY-MM-DD --out /absolute/sales.tsv [--report-version 1_0]
  finance-download --account NAME --vendor NUMBER --type FINANCIAL|FINANCE_DETAIL --region-code ZZ --from YYYY-MM --to YYYY-MM --out /absolute/finance.tsv
  analytics-request --account NAME --app ID [--access ONGOING|ONE_TIME_SNAPSHOT]
  analytics-download --account NAME --app ID --report-name NAME --granularity DAILY [--category COMMERCE] [--from YYYY-MM-DD] [--to YYYY-MM-DD] --out /absolute/analytics.tsv

 Team
  key-setup --name NAME (--issuer UUID | --individual) --p8 /absolute/AuthKey_XXXXXXXXXX.p8 [--key-id ID] [--allow-app ID,...] [--replace]
  webhook-create --account NAME --app ID --name TEXT --url https://... --events A,B   (secret from APPLE_WEBHOOK_SECRET)
  webhook-enable|webhook-disable|webhook-ping|webhook-delete --account NAME --app ID --webhook ID
  webhook-redeliver --account NAME --app ID --webhook ID --delivery ID
  webhook-listen [--port 8787]   Local signed-event receiver, bound to 127.0.0.1
  audit [--limit 100]            Recent CLI writes on this database

 Legacy screenshot sets (appScreenshots; deprecated by Apple, still served)
  screenshot-set-create --account NAME --app ID --version ID --localization ID --display-type APP_IPHONE_67
  screenshot-upload --account NAME --app ID --version ID --localization ID --set ID --file /absolute/image.png
  screenshot-resume --account NAME --screenshot ID
  screenshot-order --account NAME --app ID --version ID --localization ID --set ID --order ID1,ID2,...

 Builds and TestFlight
  build-upload --account NAME --app ID --version 1.2.3 --build 42 --file /absolute/app.ipa|.pkg [--platform IOS|MAC_OS|TV_OS|VISION_OS]
  build-resume --account NAME --upload ID
  build-cancel --account NAME --app ID --upload ID
  build-wait --account NAME --upload ID [--timeout-minutes 60] [--interval-seconds 30]
  testflight-distribute --account NAME --app ID --build ID --group ID1[,ID2,...]

Set APPLE_CONNECT_CONFIG instead of --config. No credentials are accepted as command arguments.
Review plan before apply. An interrupted apply may be retried with the same ID and digest
within its 30-minute expiry; remote state is reconciled before any further writes.
asset-cleanup only lists candidates unless --execute is given.
release-publish cannot be undone.`;

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
  territory: { type: 'string' }, 'offer-mode': { type: 'string' }, duration: { type: 'string' }, periods: { type: 'string' }, 'end-date': { type: 'string' }, offer: { type: 'string' }, 'region-code': { type: 'string' }, price: { type: 'string' }, 'start-date': { type: 'string' }, 'preserve-current-price': { type: 'boolean' },
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
  'app-price-set': 'commercial', 'iap-price-set': 'commercial', 'subscription-price-set': 'commercial', 'intro-offer-set': 'commercial', 'intro-offer-delete': 'commercial',
  'analytics-request': 'admin', 'webhook-create': 'admin', 'webhook-enable': 'admin', 'webhook-disable': 'admin', 'webhook-ping': 'admin', 'webhook-delete': 'admin', 'webhook-redeliver': 'admin',
};
const DRY_RUN_UNLESS_EXECUTE = new Set(['intro-offer-set', 'metadata-sync', 'screenshots-sync', 'availability-set', 'asset-cleanup', 'app-price-set', 'iap-price-set', 'subscription-price-set']);

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
  if (values.help || command === 'help') { console.log(HELP); return; }
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
