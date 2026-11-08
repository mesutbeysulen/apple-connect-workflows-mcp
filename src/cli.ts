#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { userInfo } from 'node:os';
import { loadConfig, requireCapability, type Account, type Capability } from './config.js';
import { PlanStore } from './plans.js';
import { ConnectService } from './service.js';
import { createServer } from './server.js';
import { screenshotClient, uploadScreenshot, resumeScreenshot } from './screenshots.js';
import { distributeToGroups } from './testflight.js';
import { waitForBuild } from './build-status.js';
import { uploadBuild, resumeBuild } from './build-upload.js';
import { uploadAsset, resumeAsset, orderPlacements, IMAGE_PLACEMENT_TYPES, type ImagePlacementType } from './asset-library.js';
import { createScreenshotSet, orderScreenshots } from './screenshot-sets.js';
import { cleanupStaleAssets } from './asset-cleanup.js';
import { uploadCreative, resumeCreative, submitCreatives, placeCreative, removeCreativePlacement, parseTargets, type CreativeKind } from './creative-assets.js';
import { releaseReadiness, submitRelease, publishRelease } from './release.js';
import { createIap, createSubscription, createSubscriptionGroup, localizeProduct, setAppPrice, setIapPrice, setSubscriptionPrice } from './commercial.js';
import { downloadSales, requestAnalytics, downloadAnalytics } from './reports.js';
import { createWebhook, deleteWebhook, pingWebhook, redeliverWebhook, setWebhookEnabled, webhookReceiver, webhookSecret } from './webhooks.js';
import { setupKey } from './key-setup.js';

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

 Header and Search Results (creative assets, iOS 27 / iPadOS 27 or later)
  creative-upload --account NAME --app ID --placements header,search --file /absolute/asset.png|.mov
                  [--reference-name TEXT] [--preview-frame 00:00:02:00]
  creative-resume --account NAME --asset ID
  creative-submit --account NAME --app ID [--images ID,...] [--videos ID,...]
  creative-place --account NAME --app ID --version ID --localization ID --placements header,search
                 (--image ID | --video ID) [--placement-group GROUP] [--replace]
  creative-remove --account NAME --app ID --version ID --localization ID --placement ID

 Release
  release-check --account NAME --app ID --version ID
  release-submit --account NAME --app ID --version ID --version-string 1.2.3
  release-publish --account NAME --app ID --version ID --version-string 1.2.3

 Commercial (price commands preview unless --execute is given)
  iap-create --account NAME --app ID --product-id ID --name TEXT --type CONSUMABLE|NON_CONSUMABLE|NON_RENEWING_SUBSCRIPTION
  subscription-group-create --account NAME --app ID --name TEXT
  subscription-create --account NAME --app ID --group ID --product-id ID --name TEXT --period ONE_MONTH [--group-level 1]
  product-localize --account NAME --app ID (--iap ID | --subscription ID) --locale tr --name TEXT [--description TEXT]
  app-price-set --account NAME --app ID --territory USA --price 4.99 [--start-date YYYY-MM-DD] [--execute]
  iap-price-set --account NAME --app ID --iap ID --territory USA --price 4.99 [--start-date YYYY-MM-DD] [--execute]
  subscription-price-set --account NAME --app ID --subscription ID --territory USA --price 4.99
                         [--start-date YYYY-MM-DD] [--preserve-current-price] [--execute]

 Reports
  sales-download --account NAME --vendor NUMBER --type SALES --subtype SUMMARY --frequency DAILY --from YYYY-MM-DD --to YYYY-MM-DD --out /absolute/sales.tsv [--report-version 1_0]
  analytics-request --account NAME --app ID [--access ONGOING|ONE_TIME_SNAPSHOT]
  analytics-download --account NAME --app ID --report-name NAME --granularity DAILY [--category COMMERCE] [--from YYYY-MM-DD] [--to YYYY-MM-DD] --out /absolute/analytics.tsv

 Team
  key-setup --name NAME --issuer UUID --p8 /absolute/AuthKey_XXXXXXXXXX.p8 [--key-id ID] [--allow-app ID,...] [--replace]
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
  build-upload --account NAME --app ID --version 1.2.3 --build 42 --file /absolute/app.ipa
  build-resume --account NAME --upload ID
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
  placements: { type: 'string' }, 'preview-frame': { type: 'string' }, asset: { type: 'string' }, images: { type: 'string' }, videos: { type: 'string' }, video: { type: 'string' }, replace: { type: 'boolean' }, placement: { type: 'string' },
  'version-string': { type: 'string' }, 'product-id': { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, period: { type: 'string' }, 'group-level': { type: 'string' }, iap: { type: 'string' }, subscription: { type: 'string' }, locale: { type: 'string' }, description: { type: 'string' },
  territory: { type: 'string' }, price: { type: 'string' }, 'start-date': { type: 'string' }, 'preserve-current-price': { type: 'boolean' },
  vendor: { type: 'string' }, subtype: { type: 'string' }, frequency: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, 'report-version': { type: 'string' }, access: { type: 'string' }, 'report-name': { type: 'string' }, granularity: { type: 'string' }, category: { type: 'string' },
  issuer: { type: 'string' }, p8: { type: 'string' }, 'key-id': { type: 'string' }, 'allow-app': { type: 'string' }, url: { type: 'string' }, events: { type: 'string' }, webhook: { type: 'string' }, delivery: { type: 'string' }, port: { type: 'string' }, limit: { type: 'string' },
  'display-type': { type: 'string' }, upload: { type: 'string' }, 'timeout-minutes': { type: 'string' }, 'interval-seconds': { type: 'string' }, 'older-than-hours': { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean' },
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];

function required<K extends keyof Values>(values: Values, ...keys: K[]): { [P in K]-?: NonNullable<Values[P]> } {
  const missing = keys.filter(key => values[key] === undefined || values[key] === '');
  if (missing.length) throw new Error(`${missing.map(k => `--${String(k)}`).join(', ')} required.`);
  return values as { [P in K]-?: NonNullable<Values[P]> };
}
const ids = (list: string) => list.split(',').map(s => s.trim()).filter(Boolean);

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
    return uploadBuild({ account: acc, appId: a.app, version: a.version, build: a.build, filePath: a.file }, screenshotClient(acc), fetch, store);
  },
  'build-resume': async (v, { store, account }) => { const acc = account(); return resumeBuild(required(v, 'upload').upload, acc, store, screenshotClient(acc)); },
  'build-wait': async (v, { account }) => {
    const a = required(v, 'upload');
    const minutes = Number(v['timeout-minutes'] ?? 60); const seconds = Number(v['interval-seconds'] ?? 30);
    if (!(minutes >= 1 && minutes <= 24 * 60) || !(seconds >= 10 && seconds <= 600)) throw new Error('--timeout-minutes 1-1440, --interval-seconds 10-600.');
    const result = await waitForBuild(screenshotClient(account()), a.upload, { timeoutMs: minutes * 60_000, intervalMs: seconds * 1000,
      onProgress: s => console.error(`${new Date().toISOString()} upload=${s.uploadState} build=${s.buildId ?? '-'} processing=${s.processingState ?? '-'}`) });
    if (!result.ok) process.exitCode = 1;
    return result;
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
    const report = await releaseReadiness(screenshotClient(account()), a.app, a.version);
    if (!report.ready) process.exitCode = 1;
    return report;
  },
  'release-submit': async (v, { account }) => {
    const a = required(v, 'app', 'version', 'version-string');
    const acc = account();
    return submitRelease({ account: acc, appId: a.app, versionId: a.version, versionString: a['version-string'] }, screenshotClient(acc));
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
  apply: 'upload', 'asset-upload': 'upload', 'asset-resume': 'upload', 'asset-order': 'upload', 'asset-cleanup': 'upload',
  'screenshot-set-create': 'upload', 'screenshot-upload': 'upload', 'screenshot-resume': 'upload', 'screenshot-order': 'upload',
  'build-upload': 'upload', 'build-resume': 'upload', 'testflight-distribute': 'upload',
  'creative-upload': 'upload', 'creative-resume': 'upload', 'creative-place': 'upload', 'creative-remove': 'upload',
  'creative-submit': 'review', 'release-submit': 'review', 'release-publish': 'release',
  'iap-create': 'commercial', 'subscription-group-create': 'commercial', 'subscription-create': 'commercial', 'product-localize': 'commercial',
  'app-price-set': 'commercial', 'iap-price-set': 'commercial', 'subscription-price-set': 'commercial',
  'analytics-request': 'admin', 'webhook-create': 'admin', 'webhook-enable': 'admin', 'webhook-disable': 'admin', 'webhook-ping': 'admin', 'webhook-delete': 'admin', 'webhook-redeliver': 'admin',
};
const DRY_RUN_UNLESS_EXECUTE = new Set(['asset-cleanup', 'app-price-set', 'iap-price-set', 'subscription-price-set']);

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options });
  const command = positionals[0] ?? 'serve';
  if (values.help || command === 'help') { console.log(HELP); return; }
  const known = ['serve', 'doctor', 'key-setup', 'webhook-listen'].includes(command) || command in commands;
  if (!known || positionals.length > 1) throw new Error('Unknown command. Use --help.');
  if (command === 'key-setup') {
    const a = required(values, 'name', 'issuer', 'p8');
    const configPath = values.config ?? process.env.APPLE_CONNECT_CONFIG;
    if (!configPath) throw new Error('Pass --config or set APPLE_CONNECT_CONFIG; the file is created if missing.');
    console.log(JSON.stringify(setupKey({ name: a.name, issuerId: a.issuer, p8Path: a.p8, keyId: values['key-id'], configPath, allowedAppIds: ids(values['allow-app'] ?? ''), replace: values.replace === true }), null, 2));
    return;
  }
  const config = loadConfig(values.config);
  const store = new PlanStore(config.databasePath);
  const service = new ConnectService(config, store);
  if (command === 'serve') {
    serveStdio(() => createServer(service));
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
    if (writes && command !== 'apply') requireCapability(config, osUser, required(values, 'account').account, capability);
    if (command === 'apply' && values.plan) requireCapability(config, osUser, store.get(values.plan).body.account, 'upload');
    const account = () => service.account(required(values, 'account').account);
    try {
      const result = await commands[command]!(values, { service, store, account });
      if (writes) store.audit({ osUser, command, account: values.account, appId: values.app, ok: true });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (writes) store.audit({ osUser, command, account: values.account, appId: values.app, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : 'failed' });
      throw error;
    }
  } finally { store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
