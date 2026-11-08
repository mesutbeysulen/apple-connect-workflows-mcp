import { z } from 'zod';
import { accountIdentity, requireWrite, type Account, type Config } from './config.js';
import { AppleClient, createTokenProvider, type AppleAPI } from './apple.js';
import { verifyEditableVersion } from './screenshots.js';
import { PlanStore, type Changes, type Plan, type Step } from './plans.js';

export const idSchema = z.string().regex(/^[A-Za-z0-9-]+$/).max(128);
const text = (max: number) => z.string().refine(s => [...s].length <= max, `Maximum ${max} characters`);
export const changesSchema = z.object({
  description: text(4000).optional(),
  whatsNew: text(4000).optional(),
  promotionalText: text(170).optional(),
  keywords: z.string().refine(s => Buffer.byteLength(s, 'utf8') <= 100, 'Maximum 100 UTF-8 bytes').optional(),
}).strict().refine(x => Object.keys(x).length > 0, 'Provide at least one metadata field');
export const prepareSchema = z.object({
  account: z.string(), appId: idSchema, versionId: idSchema,
  localizations: z.array(z.object({ locale: z.string().min(2).max(30), changes: changesSchema }).strict()).min(1).max(50)
    .refine(rows => new Set(rows.map(x => x.locale)).size === rows.length, 'Duplicate locale'),
}).strict();
const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export class ConnectService {
  constructor(public config: Config, public store: PlanStore,
    private factory: (account: Account) => AppleAPI = a => new AppleClient(createTokenProvider(a))) {}
  account(name: string): Account {
    const account = this.config.accounts.find(a => a.name === name);
    if (!account) throw new Error('Unknown account name. Use accounts_list.');
    return account;
  }
  api(name: string): AppleAPI { return this.factory(this.account(name)); }
  accounts() { return this.config.accounts.map(a => ({ name: a.name, readOnly: a.readOnly, allowedAppIds: a.allowedAppIds, authentication: 'not_checked' })); }
  checkVersion(api: AppleAPI, appId: string, versionId: string): Promise<void> { return verifyEditableVersion(api, appId, versionId); }
  async prepare(input: z.infer<typeof prepareSchema>): Promise<Plan> {
    input = prepareSchema.parse(input);
    const account = this.account(input.account);
    const api = this.api(input.account);
    await this.checkVersion(api, input.appId, input.versionId);
    const result = await api.list(`/v1/appStoreVersions/${input.versionId}/appStoreVersionLocalizations?limit=200`, 2000);
    if (result.truncated) throw new Error('Incomplete localization inventory; cannot prepare a safe plan.');
    const steps: Step[] = [];
    for (const entry of input.localizations) {
      const localization = result.data.find(row => row.attributes.locale === entry.locale);
      if (!localization) throw new Error(`Locale ${entry.locale} does not exist on this version. Create it in App Store Connect first.`);
      const before: Record<string, unknown> = {};
      const after: Changes = {};
      for (const [field, value] of Object.entries(entry.changes)) {
        if (value === undefined || equal(localization.attributes[field], value)) continue;
        before[field] = localization.attributes[field] ?? null;
        after[field] = value;
      }
      if (Object.keys(after).length) steps.push({ localizationId: localization.id, locale: entry.locale, before, after });
    }
    if (!steps.length) throw new Error('No changes: remote metadata already matches.');
    const now = Date.now();
    return this.store.create({ account: account.name, identity: accountIdentity(account), appId: input.appId,
      versionId: input.versionId, createdAt: now, expiresAt: now + 30 * 60_000, steps });
  }
  private async state(api: AppleAPI, step: Step): Promise<'desired' | 'baseline'> {
    const resource = await api.get(`/v1/appStoreVersionLocalizations/${step.localizationId}`);
    if (resource.id !== step.localizationId || resource.attributes.locale !== step.locale) throw new Error('Localization identity changed.');
    const attrs = resource.attributes;
    if (Object.entries(step.after).every(([k, v]) => equal(attrs[k], v))) return 'desired';
    if (Object.entries(step.before).every(([k, v]) => equal(attrs[k], v))) return 'baseline';
    throw new Error(`Conflict in ${step.locale}: metadata changed since the preview. Prepare a new plan.`);
  }
  async apply(id: string, expectedDigest: string): Promise<Plan> {
    let plan = this.store.get(id);
    if (plan.digest !== expectedDigest) throw new Error('Digest does not match the reviewed plan.');
    const account = this.account(plan.body.account);
    if (accountIdentity(account) !== plan.body.identity) throw new Error('Account credentials changed; prepare a new plan.');
    requireWrite(account, plan.body.appId);
    if (plan.status === 'completed') return plan;
    if (Date.now() >= plan.body.expiresAt) throw new Error('Plan expired; prepare a new preview.');
    const lease = this.store.acquire(plan);
    const completed: string[] = [...plan.completed];
    try {
      plan = this.store.get(id);
      if (plan.status === 'completed') return plan;
      const api = this.api(account.name);
      await this.checkVersion(api, plan.body.appId, plan.body.versionId);
      // Detect known conflicts across the entire plan before the first mutation.
      for (const step of plan.body.steps) { this.store.heartbeat(lease); await this.state(api, step); }
      this.store.update(id, 'applying', completed);
      for (const step of plan.body.steps) {
        this.store.heartbeat(lease);
        if (Date.now() >= plan.body.expiresAt) throw new Error('Plan expired during execution; inspect completed steps and prepare a new plan.');
        if (await this.state(api, step) !== 'desired') {
          await this.checkVersion(api, plan.body.appId, plan.body.versionId);
          this.store.heartbeat(lease);
          if (Date.now() >= plan.body.expiresAt) throw new Error('Plan expired before write.');
          await api.patch(`/v1/appStoreVersionLocalizations/${step.localizationId}`, 'appStoreVersionLocalizations', step.localizationId, step.after);
          if (await this.state(api, step) !== 'desired') throw new Error('Apple has not confirmed the requested values; retry to reconcile.');
        }
        if (!completed.includes(step.localizationId)) completed.push(step.localizationId);
        this.store.update(id, 'applying', completed);
      }
      this.store.update(id, 'completed', completed);
    } catch (error) {
      this.store.update(id, 'needs_reconciliation', completed, error instanceof Error ? error.message : 'Operation failed');
      throw error;
    } finally { this.store.release(lease); }
    return this.store.get(id);
  }
}
