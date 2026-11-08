import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const absolutePath = z.string().refine(isAbsolute, 'Use an absolute path');
export const accountSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  issuerId: z.string().uuid(),
  keyId: z.string().regex(/^[A-Za-z0-9]{10}$/),
  privateKeyPath: absolutePath,
  readOnly: z.boolean().default(true),
  allowedAppIds: z.array(z.string().regex(/^\d+$/)).default([]),
}).strict();
export const CAPABILITIES = ['upload', 'review', 'release', 'commercial', 'admin'] as const;
export type Capability = typeof CAPABILITIES[number];
export const operatorSchema = z.object({
  user: z.string().min(1),
  accounts: z.array(z.string()).min(1),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1),
}).strict();
export const configSchema = z.object({
  /** Optional local policy by OS user. Absent means every local user keeps full CLI access. */
  operators: z.array(operatorSchema).optional(),
  databasePath: absolutePath.default(resolve(homedir(), '.apple-connect-mcp', 'plans.sqlite')),
  accounts: z.array(accountSchema).min(1).refine(a => new Set(a.map(x => x.name)).size === a.length, 'Account names must be unique'),
}).strict();
export type Account = z.infer<typeof accountSchema>;
export type Config = z.infer<typeof configSchema>;
export function loadConfig(path = process.env.APPLE_CONNECT_CONFIG): Config {
  if (!path) throw new Error('Set APPLE_CONNECT_CONFIG to your config file. See config.example.json.');
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function accountIdentity(account: Account): string {
  return createHash('sha256').update(`${account.issuerId}:${account.keyId}`).digest('hex');
}
export function requireWrite(account: Account, appId: string): void {
  if (account.readOnly) throw new Error('Account is read-only. Enable writes in local configuration first.');
  if (!account.allowedAppIds.includes(appId)) throw new Error('App is not in this account’s write allowlist.');
}
/**
 * Local guard for shared machines. It trusts the OS user name and is not authentication:
 * anyone able to edit the config or read the key can bypass it.
 */
export function requireCapability(config: Config, user: string, account: string, capability: Capability): void {
  if (!config.operators) return;
  const allowed = config.operators.some(o => o.user === user && (o.accounts.includes('*') || o.accounts.includes(account)) && o.capabilities.includes(capability));
  if (!allowed) throw new Error(`OS user ${user} lacks the ${capability} capability for account ${account}.`);
}
