import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Read-only smoke test: drives the real MCP read tools in process, in dependency order, discovering
 * IDs from earlier answers. The report keeps statuses, counts and field names, never field values.
 */

type Message = Record<string, unknown> & { id?: number; method?: string };
interface Transport {
  start(): Promise<void>; send(message: Message): Promise<void>; close(): Promise<void>;
  onmessage?: (message: Message) => void; onclose?: () => void; onerror?: (error: Error) => void;
}

/** Minimal JSON-RPC client over an in-memory transport, so the CLI needs no MCP client package. */
async function connect(server: McpServer) {
  const pending = new Map<number, (message: Message) => void>();
  const transport: Transport = {
    async start() {}, async close() { transport.onclose?.(); },
    async send(message) { if (typeof message.id === 'number' && !message.method) pending.get(message.id)?.(message); },
  };
  await server.connect(transport as never);
  let next = 1;
  const request = (method: string, params: unknown) => new Promise<Message>(resolve => {
    const id = next++;
    pending.set(id, message => { pending.delete(id); resolve(message); });
    transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
  });
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-read', version: '1' } });
  if (init.error) throw new Error(`MCP initialize failed: ${JSON.stringify(init.error)}`);
  transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const reply = await request('tools/call', { name, arguments: args });
      if (reply.error) throw new Error((reply.error as { message?: string }).message ?? 'MCP error');
      const result = reply.result as { isError?: boolean; content?: { text?: string }[]; structuredContent?: { result?: unknown } };
      if (result.isError) throw new Error(result.content?.map(c => c.text).join(' ') || 'Tool error');
      return result.structuredContent?.result;
    },
    close: () => server.close(),
  };
}

export interface SmokeStep {
  tool: string;
  status: 'ok' | 'error' | 'skipped';
  outcome?: 'forbidden' | 'not-found' | 'rate-limited' | 'apple-error' | 'tool-error';
  ms?: number;
  items?: number;
  truncated?: boolean;
  /** Attribute and relationship names of the first item, or top-level keys: field names only. */
  fields?: string[];
  error?: string;
  reason?: string;
}

export interface SmokeReport {
  account: string; appId?: string; startedAt: string; finishedAt: string;
  summary: { ok: number; error: number; skipped: number; forbidden: number };
  steps: SmokeStep[];
}

type Resource = { id?: unknown; type?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, unknown> };

function classify(message: string): SmokeStep['outcome'] {
  if (/HTTP (401|403)/.test(message)) return 'forbidden';
  if (/HTTP 404/.test(message)) return 'not-found';
  if (/HTTP 429/.test(message)) return 'rate-limited';
  if (/Apple API HTTP/.test(message)) return 'apple-error';
  return 'tool-error';
}

function shape(value: unknown): Pick<SmokeStep, 'items' | 'truncated' | 'fields'> {
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    const { data, truncated } = value as { data: Resource[]; truncated?: boolean };
    const first = data[0];
    return { items: data.length, truncated: truncated === true, fields: first ? [...Object.keys(first.attributes ?? {}), ...Object.keys(first.relationships ?? {}).map(k => `→${k}`)] : [] };
  }
  if (Array.isArray(value)) return { items: value.length };
  if (value && typeof value === 'object') {
    const resource = value as Resource;
    if (resource.attributes) return { fields: Object.keys(resource.attributes) };
    return { fields: Object.keys(value) };
  }
  return {};
}

/** Every resource of one of these types found anywhere in the value, in order. */
export function findIds(value: unknown, types: string[], out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) findIds(item, types, out); return out; }
  if (value && typeof value === 'object') {
    const resource = value as Resource;
    if (typeof resource.id === 'string' && typeof resource.type === 'string' && types.includes(resource.type) && !out.includes(resource.id)) out.push(resource.id);
    for (const child of Object.values(value)) if (child && typeof child === 'object') findIds(child, types, out);
  }
  return out;
}

export async function smokeRead(server: McpServer, options: { account: string; appId?: string }): Promise<SmokeReport> {
  const startedAt = new Date().toISOString();
  const client = await connect(server);
  const steps: SmokeStep[] = [];
  const account = options.account;
  const run = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const started = Date.now();
    try {
      const value = await client.call(tool, args);
      steps.push({ tool, status: 'ok', ms: Date.now() - started, ...shape(value) });
      return value;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      steps.push({ tool, status: 'error', outcome: classify(message), ms: Date.now() - started, error: message });
      return undefined;
    }
  };
  const skip = (tool: string, reason: string) => { steps.push({ tool, status: 'skipped', reason }); };
  /** Runs the tool when the ID exists, otherwise records why it was skipped. */
  const withId = async (tool: string, id: string | undefined, reason: string, args: (id: string) => Record<string, unknown>) =>
    id ? run(tool, args(id)) : (skip(tool, reason), undefined);
  const first = (value: unknown, ...types: string[]) => findIds(value, types)[0];

  try {
    // Local tools: no Apple calls.
    await run('accounts_list', {});
    await run('workflow_catalog', {});
    await run('submission_manual_steps', {});
    await run('api_catalog_search', { query: 'appStoreVersions', limit: 3 });
    await run('audit_log_list', { limit: 5 });
    await run('webhook_events_list', { limit: 5 });

    if (!await run('account_check', { account })) return finish();
    const apps = await run('apps_list', { account, limit: 200 });
    const appRows = ((apps as { data?: Resource[] } | undefined)?.data ?? []);
    const app = options.appId ? appRows.find(a => a.id === options.appId) ?? { id: options.appId } : appRows[0];
    const appId = typeof app?.id === 'string' ? app.id : undefined;
    options.appId = appId;
    const bundleId = typeof app?.attributes?.bundleId === 'string' ? app.attributes.bundleId : undefined;

    // Account-wide reads.
    await run('users_list', { account });
    await run('user_invitations_list', { account });
    await run('devices_list', { account });
    await run('certificates_list', { account });
    await run('profiles_list', { account });
    await run('sandbox_testers_list', { account });
    await run('territories_list', { account });
    await run('app_categories_list', { account, platform: 'IOS' });
    await run('asset_ref_data', { account });
    await run('game_center_matchmaking', { account });
    const bundles = await run('bundle_ids_list', { account, ...(bundleId ? { identifier: bundleId } : {}) });
    await withId('bundle_id_capabilities', first(bundles, 'bundleIds'), 'no bundle ID', id => ({ account, bundleId: id }));

    if (!appId) {
      skip('app reads', 'the account has no apps');
      return finish();
    }
    const a = { account, appId };

    // App, versions, localizations, media.
    await run('app_info_get', a);
    const versions = await run('versions_list', { ...a, limit: 20 });
    const versionId = first(versions, 'appStoreVersions');
    const builds = await run('builds_list', { ...a, limit: 20 });
    const buildId = first(builds, 'builds');
    const localizations = await withId('localizations_list', versionId, 'no App Store version', id => ({ account, versionId: id }));
    const localizationId = first(localizations, 'appStoreVersionLocalizations');
    await withId('screenshot_sets_list', localizationId, 'no version localization', id => ({ account, localizationId: id }));
    await withId('asset_placements_list', localizationId, 'no version localization', id => ({ account, localizationId: id }));
    const images = await run('asset_library_images', { ...a, limit: 5 });
    await withId('asset_image_status', first(images, 'appAssetLibraryImages'), 'no Asset Library image', id => ({ account, imageId: id }));
    await run('asset_cleanup_preview', a);
    await withId('creative_overview', versionId, 'no App Store version', id => ({ account, versionId: id }));
    await withId('release_readiness', versionId, 'no App Store version', id => ({ ...a, versionId: id }));
    await run('listing_extras_get', a);

    // Builds, export compliance, TestFlight, health.
    const uploads = await run('build_uploads_list', a);
    const uploadId = first(uploads, 'buildUploads');
    await withId('build_upload_status', uploadId, 'no build upload', id => ({ account, uploadId: id }));
    await withId('build_processing_status', uploadId, 'no build upload', id => ({ account, uploadId: id }));
    await run('encryption_declarations_list', a);
    await withId('build_encryption_status', buildId, 'no build', id => ({ account, buildId: id }));
    const groups = await run('beta_groups_list', a);
    await withId('beta_testers_list', first(groups, 'betaGroups'), 'no beta group', id => ({ account, groupId: id }));
    await run('beta_feedback_list', { ...a, kind: 'screenshots', limit: 5 });
    const crashes = await run('beta_feedback_list', { ...a, kind: 'crashes', limit: 5 });
    await withId('beta_crash_log', first(crashes, 'betaFeedbackCrashSubmissions'), 'no beta crash report', id => ({ account, submissionId: id }));
    await run('perf_metrics', a);
    await withId('diagnostic_signatures_list', buildId, 'no build', id => ({ account, buildId: id }));

    // Review.
    const submissions = await run('review_submissions_list', a);
    await withId('review_submission_items', first(submissions, 'reviewSubmissions'), 'no review submission', id => ({ account, submissionId: id }));
    await run('customer_reviews_list', { ...a, limit: 5 });

    // In-app purchases.
    const iaps = await run('iap_list', a);
    const iapId = first(iaps, 'inAppPurchases');
    const iapVersions = await withId('product_versions_list', iapId, 'no in-app purchase', id => ({ account, kind: 'iap', productId: id }));
    const iapVersionId = first(iapVersions, 'inAppPurchaseVersions');
    await withId('product_version_localizations', iapVersionId, 'no in-app purchase version', id => ({ account, kind: 'iap', versionId: id }));
    await withId('product_version_images', iapVersionId, 'no in-app purchase version', id => ({ account, kind: 'iap', versionId: id }));
    await withId('product_availability_get', iapId, 'no in-app purchase', id => ({ account, kind: 'iap', productId: id }));
    await withId('offer_codes_list', iapId, 'no in-app purchase', id => ({ account, kind: 'iap', productId: id }));

    // Subscriptions.
    const subscriptionGroups = await run('subscription_groups_list', a);
    const groupId = first(subscriptionGroups, 'subscriptionGroups');
    await withId('product_versions_list', groupId, 'no subscription group', id => ({ account, kind: 'subscription-group', productId: id }));
    const subscriptions = await withId('subscriptions_list', groupId, 'no subscription group', id => ({ account, groupId: id }));
    const subscriptionId = first(subscriptions, 'subscriptions');
    const subscriptionVersions = await withId('product_versions_list', subscriptionId, 'no subscription', id => ({ account, kind: 'subscription', productId: id }));
    await withId('product_version_localizations', first(subscriptionVersions, 'subscriptionVersions'), 'no subscription version', id => ({ account, kind: 'subscription', versionId: id }));
    for (const tool of ['subscription_prices_list', 'promotional_offers_list', 'win_back_offers_list'] as const)
      await withId(tool, subscriptionId, 'no subscription', id => ({ account, subscriptionId: id }));
    await withId('introductory_offers_list', subscriptionId, 'no subscription', id => ({ account, subscriptionId: id, territory: 'USA' }));
    await withId('product_availability_get', subscriptionId, 'no subscription', id => ({ account, kind: 'subscription', productId: id }));
    await withId('offer_codes_list', subscriptionId, 'no subscription', id => ({ account, kind: 'subscription', productId: id }));
    await run('promoted_purchases_list', a);

    // Marketing.
    const pages = await run('custom_product_pages_list', a);
    await withId('custom_product_page_localizations', first(pages, 'appCustomProductPageVersions'), 'no Custom Product Page version', id => ({ account, versionId: id }));
    await run('app_events_list', a);
    await run('experiments_list', a);

    // Xcode Cloud and Game Center.
    const cloud = await run('xcode_cloud_overview', { ...a, recent: 5 });
    await withId('xcode_cloud_build_run', first(cloud, 'ciBuildRuns'), 'no Xcode Cloud build run', id => ({ account, buildRunId: id }));
    const gameCenter = await run('game_center_overview', a);
    for (const [kind, types] of [
      ['leaderboard', ['gameCenterLeaderboards']], ['achievement', ['gameCenterAchievements']],
      ['leaderboard-set', ['gameCenterLeaderboardSets']], ['activity', ['gameCenterActivities']], ['challenge', ['gameCenterChallenges']],
    ] as const) await withId('game_center_versions', first(gameCenter, ...types), `no Game Center ${kind}`, id => ({ account, kind, id }));

    // Reports and webhooks.
    const requests = await run('analytics_requests_list', a);
    await withId('analytics_reports_list', first(requests, 'analyticsReportRequests'), 'no analytics report request', id => ({ account, requestId: id }));
    const hooks = await run('webhooks_list', a);
    await withId('webhook_deliveries_list', first(hooks, 'webhooks'), 'no webhook', id => ({ account, webhookId: id }));
    return finish();
  } finally { await client.close(); }

  function finish(): SmokeReport {
    const count = (status: SmokeStep['status']) => steps.filter(s => s.status === status).length;
    return {
      account, appId: options.appId, startedAt, finishedAt: new Date().toISOString(),
      summary: { ok: count('ok'), error: count('error'), skipped: count('skipped'), forbidden: steps.filter(s => s.outcome === 'forbidden').length },
      steps,
    };
  }
}
