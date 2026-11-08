import { createPrivateKey, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configSchema, type Config } from './config.js';

export interface KeySetupInput { name: string; issuerId: string; keyId?: string; p8Path: string; configPath: string; keysDir?: string; allowedAppIds?: string[]; replace?: boolean }
export interface KeySetupResult { account: string; keyId: string; privateKeyPath: string; configPath: string; readOnly: boolean; next: string[] }
/**
 * Validates an App Store Connect .p8, stores a private copy and adds the account to the config.
 * Accounts start read-only unless write-allowed apps are named. The key's contents are never printed.
 */
export function setupKey(input: KeySetupInput): KeySetupResult {
  const { name, issuerId, p8Path, configPath, allowedAppIds = [], replace = false } = input;
  if (!isAbsolute(p8Path) || !isAbsolute(configPath)) throw new Error('--p8 and --config must be absolute paths.');
  const keyId = input.keyId ?? basename(p8Path).match(/^AuthKey_([A-Za-z0-9]{10})\.p8$/)?.[1];
  if (!keyId) throw new Error('Pass --key-id, or keep Apple\'s AuthKey_XXXXXXXXXX.p8 file name.');
  const pem = readFileSync(p8Path);
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error('File is not a readable private key.'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Apple API key must be an ES256 (P-256) private key.');
  const current: Partial<Config> = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const accounts = current.accounts ?? [];
  if (accounts.some(a => a.name === name) && !replace) throw new Error(`Account ${name} already exists. Pass --replace to overwrite it.`);
  const keysDir = input.keysDir ?? resolve(homedir(), '.apple-connect-mcp', 'keys');
  const privateKeyPath = join(keysDir, `AuthKey_${keyId}.p8`);
  const account = { name, issuerId, keyId, privateKeyPath, readOnly: allowedAppIds.length === 0, allowedAppIds };
  // Validate the whole resulting config before anything is written.
  const next = configSchema.parse({ ...current, accounts: [...accounts.filter(a => a.name !== name), account] });
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, pem, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, configPath);
  } finally { rmSync(temporary, { force: true }); }
  return { account: name, keyId, privateKeyPath, configPath, readOnly: account.readOnly, next: [
    `export APPLE_CONNECT_CONFIG="${configPath}"`, 'node dist/cli.js doctor', `After doctor succeeds, you may delete the original key at ${p8Path}.`] };
}
