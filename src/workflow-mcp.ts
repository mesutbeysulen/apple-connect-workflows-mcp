import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { accountIdentity, loadConfig, requireCapability, type Capability } from './config.js';
import { redactSecrets } from './catalog.js';
import type { ConnectService } from './service.js';

// Deliberately omit credential setup, the HTTP listener, and arbitrary API paths.
const WRITE_GROUPS: Record<Capability, string[]> = {
  upload: `apply app-update app-info-set app-category-set age-rating-set version-create version-update version-build-set build-compliance encryption-declaration-create encryption-document-upload build-encryption-attach version-localize metadata-sync screenshots-sync preview-upload preview-place review-detail-set review-attachment-upload beta-info-set beta-notes-set beta-review-detail-set asset-upload asset-resume asset-order asset-cleanup screenshot-set-create screenshot-upload screenshot-resume screenshot-order build-upload build-resume build-cancel testflight-distribute creative-upload creative-resume creative-place creative-remove`.split(' '),
  review: `review-cancel review-item-remove beta-submit creative-submit release-submit`.split(' '),
  release: `phased-release release-publish`.split(' '),
  commercial: `availability-set iap-create subscription-group-create subscription-create product-localize product-version-create product-version-localize product-version-image-upload app-price-set iap-price-set subscription-price-set intro-offer-set intro-offer-delete`.split(' '),
  admin: `bundle-id-create beta-group-create beta-tester-add beta-tester-remove review-reply analytics-request webhook-create webhook-enable webhook-disable webhook-ping webhook-delete webhook-redeliver api-apply`.split(' '),
};
const READ_COMMANDS = new Set(`help doctor audit plan api-plan-show release-check build-wait sales-download finance-download analytics-download`.split(' '));
const DRY_RUN = new Set(`intro-offer-set metadata-sync screenshots-sync availability-set asset-cleanup app-price-set iap-price-set subscription-price-set`.split(' '));
const STRING_OPTIONS = new Set(`offer-mode duration periods end-date offer region-code plan digest account app set version localization file screenshot build group image order placement-group placement-type reference-name primary-locale content-rights subtitle privacy-url privacy-choices-url privacy-text primary primary-sub1 primary-sub2 secondary secondary-sub1 secondary-sub2 territories platform copyright release-type release-date uses-encryption declaration app-description proprietary-crypto third-party-crypto french-store keywords whats-new promotional-text support-url marketing-url dir first-name last-name phone email notes demo-required demo-name submission item state feedback-email emails tester review text identifier placements preview-frame asset images videos video placement version-string product-id name type period group-level iap subscription locale description kind product custom-app-name territory price start-date vendor subtype frequency from to out report-version access report-name granularity category url events webhook delivery limit display-type upload timeout-minutes interval-seconds older-than-hours manual-checks iap-version-ids subscription-version-ids subscription-group-version-ids`.split(' '));
const BOOLEAN_OPTIONS = new Set(`new-territories public-link feedback replace preserve-current-price`.split(' '));
const OPTION_SCHEMA = z.record(z.string(), z.union([z.string(), z.boolean()]));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

function capability(command: string): Capability | undefined {
  return (Object.entries(WRITE_GROUPS) as [Capability, string[]][]).find(([, names]) => names.includes(command))?.[0];
}
function validate(command: string, args: Record<string, string | boolean>, mode: 'read' | 'write'): void {
  if (mode === 'write' ? !capability(command) : !READ_COMMANDS.has(command)) throw new Error('Command is not available in this workflow mode.');
  for (const [key, value] of Object.entries(args)) {
    if (key === 'execute' || key === 'config' || key === 'help' || key === 'p8' || key === 'issuer' || key === 'key-id' || key === 'port') throw new Error(`--${key} is managed by the server or unavailable.`);
    if (typeof value === 'string' && (!STRING_OPTIONS.has(key) || value.length > 100_000 || value.includes('\0'))) throw new Error(`Invalid --${key} value.`);
    if (typeof value === 'boolean' && !BOOLEAN_OPTIONS.has(key)) throw new Error(`--${key} does not accept a boolean.`);
  }
  if (mode === 'write' && !['apply', 'api-apply'].includes(command) && typeof args.account !== 'string') throw new Error('--account is required.');
  if (mode === 'write' && ['apply', 'api-apply'].includes(command) && (typeof args.plan !== 'string' || typeof args.digest !== 'string')) throw new Error('--plan and --digest are required.');
}
function argv(command: string, args: Record<string, string | boolean>, configPath?: string, execute = false): string[] {
  const out = [cliPath, command];
  if (configPath) out.push('--config', configPath);
  for (const [key, value] of Object.entries(args)) {
    if (value === true) out.push(`--${key}`);
    else if (typeof value === 'string') out.push(`--${key}`, value);
  }
  if (execute && DRY_RUN.has(command)) out.push('--execute');
  return out;
}
async function runCli(command: string, args: Record<string, string | boolean>, configPath?: string, execute = false): Promise<unknown> {
  const child = spawn(process.execPath, argv(command, args, configPath, execute), { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, shell: false });
  let stdout = ''; let stderr = ''; let oversized = false;
  const limit = 4 * 1024 * 1024;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > limit) { oversized = true; child.kill(); } });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > limit) { oversized = true; child.kill(); } });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (oversized) throw new Error('CLI output exceeded 4 MiB. Use a narrower query.');
  if (code !== 0) throw new Error(redactSecrets(stderr.trim().slice(0, 3000)) as string || `CLI exited with code ${code}.`);
  if (command === 'help') return stdout;
  try { return JSON.parse(stdout); } catch {
    if (command === 'doctor') {
      try { return stdout.trim().split('\n').map(line => JSON.parse(line)); } catch { /* malformed doctor output */ }
    }
    throw new Error('CLI returned invalid JSON.');
  }
}
async function hashPath(path: string): Promise<string> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('Input path must not be a symlink.');
  const hash = createHash('sha256');
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) { hash.update(name); hash.update(await hashPath(join(path, name))); }
  } else if (stat.isFile()) {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } else throw new Error('Input path must be a regular file or directory.');
  return hash.digest('hex');
}
async function inputHashes(args: Record<string, string | boolean>): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const key of ['file', 'dir']) if (typeof args[key] === 'string') files[key] = await hashPath(args[key]);
  return files;
}
const output = (raw: unknown) => {
  const value = redactSecrets(raw);
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } };
};

export function registerWorkflowTools(server: McpServer, service: ConnectService, configPath?: string): void {
  server.registerTool('workflow_catalog', {
    description: 'List CLI workflows available through MCP. Writes use workflow_prepare then workflow_apply; read commands use workflow_run.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => output({ writes: WRITE_GROUPS, reads: [...READ_COMMANDS], dryRunCommands: [...DRY_RUN], argumentFormat: 'CLI option names without --; string or boolean values', usage: await runCli('help', {}, configPath) }));
  server.registerTool('workflow_run', {
    description: 'Run an allowlisted CLI read/report workflow. sales-download and analytics-download may create a local report file.',
    inputSchema: z.object({ command: z.string(), args: OPTION_SCHEMA.default({}) }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ command, args }) => { validate(command, args, 'read'); return output(await runCli(command, args, configPath)); });
  server.registerTool('workflow_prepare', {
    description: 'Save an exact CLI write workflow as a 30-minute plan. Dry-run capable commands fetch a preview; other commands show exact inputs. No Apple write occurs.',
    inputSchema: z.object({ command: z.string(), args: OPTION_SCHEMA }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ command, args }) => {
    validate(command, args, 'write');
    const accountName = command === 'api-apply' ? service.store.apiPlan(args.plan as string).body.account : command === 'apply' ? service.store.get(args.plan as string).body.account : args.account as string;
    const account = service.account(accountName);
    requireCapability(service.config, userInfo().username, accountName, capability(command)!);
    if (account.readOnly) throw new Error('Account is read-only. Enable writes in local configuration first.');
    const files = await inputHashes(args);
    const preview = DRY_RUN.has(command) ? await runCli(command, args, configPath) : { command, args, note: 'Input review only; this command has no dry run.' };
    const now = Date.now();
    const plan = service.store.createWorkflowPlan({ command, args, account: accountName, identity: accountIdentity(account), files, createdAt: now, expiresAt: now + 30 * 60_000, preview });
    return output(plan);
  });
  server.registerTool('workflow_plan_get', {
    description: 'Inspect the saved workflow, preview, digest, expiry and status before applying it.',
    inputSchema: z.object({ planId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ planId }) => output(service.store.workflowPlan(planId)));
  server.registerTool('workflow_apply', {
    description: 'Execute a saved workflow once with its exact digest. May upload, delete, submit, change prices, or publish. The CLI enforces local policy, leases and audit records.',
    inputSchema: z.object({ planId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ planId, digest }) => {
    const plan = service.store.workflowPlan(planId);
    if (plan.digest !== digest) throw new Error('Workflow digest mismatch.');
    if (plan.status !== 'pending') throw new Error(`Workflow status is ${plan.status}; create a new plan to retry.`);
    if (Date.now() > plan.body.expiresAt) throw new Error('Workflow plan expired.');
    const currentConfig = loadConfig(configPath);
    const account = currentConfig.accounts.find(item => item.name === plan.body.account);
    if (!account) throw new Error('Planned account is no longer configured.');
    if (accountIdentity(account) !== plan.body.identity) throw new Error('Account identity changed.');
    requireCapability(currentConfig, userInfo().username, plan.body.account, capability(plan.body.command)!);
    if (account.readOnly) throw new Error('Account is read-only.');
    const current = await inputHashes(plan.body.args);
    if (JSON.stringify(current) !== JSON.stringify(plan.body.files)) throw new Error('Input file or directory changed; prepare a new plan.');
    if (!service.store.claimWorkflowPlan(planId)) throw new Error('Workflow already claimed.');
    try {
      const result = await runCli(plan.body.command, plan.body.args, configPath, true);
      const partial = (result as { ok?: unknown } | null)?.ok === false;
      service.store.finishWorkflowPlan(planId, partial ? 'uncertain' : 'completed', result, partial ? 'CLI reported partial failure.' : null);
      return output(service.store.workflowPlan(planId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CLI failed';
      service.store.finishWorkflowPlan(planId, 'uncertain', null, message);
      throw error;
    }
  });
}
