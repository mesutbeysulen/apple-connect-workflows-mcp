import { readFileSync } from 'node:fs';

export interface Endpoint { method: string; path: string; tag: string; deprecated?: boolean; filters?: string[]; body?: string }
let cached: { apiVersion: string; endpoints: Endpoint[] } | undefined;
export function catalog(): { apiVersion: string; endpoints: Endpoint[] } {
  return cached ??= JSON.parse(readFileSync(new URL('../catalog/endpoints.json', import.meta.url), 'utf8'));
}
/** Every whitespace-separated term must appear in the endpoint's method, path, tag or filters. */
export function searchCatalog(query: string, method?: string, limit = 50): { apiVersion: string; total: number; endpoints: Endpoint[] } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const { apiVersion, endpoints } = catalog();
  const matches = endpoints.filter(e => (!method || e.method === method) && terms.every(term => `${e.method} ${e.path} ${e.tag} ${(e.filters ?? []).join(' ')}`.toLowerCase().includes(term)));
  return { apiVersion, total: matches.length, endpoints: matches.slice(0, limit) };
}
/** Finds the catalog entry for a concrete method and path, or undefined. */
export function matchEndpoint(method: string, path: string): Endpoint | undefined {
  const url = new URL(path, 'https://api.appstoreconnect.apple.com');
  if (url.origin !== 'https://api.appstoreconnect.apple.com' || !path.startsWith('/')) throw new Error('Use an API path such as /v1/apps.');
  const parts = url.pathname.split('/');
  return catalog().endpoints.find(e => {
    if (e.method !== method) return false;
    const template = e.path.split('/');
    return template.length === parts.length && template.every((segment, i) => /^\{.+\}$/.test(segment) ? /^[A-Za-z0-9._-]+$/.test(parts[i]!) : segment === parts[i]);
  });
}
/**
 * Requests Apple's OpenAPI document allows but the live API rejects, found by smoke-read against a
 * real account. Contract tests fail on them, and generic reads explain the working alternative.
 */
const APPLE_REJECTS: { method: string; path: RegExp; query?: string; reason: string }[] = [
  { method: 'GET', path: /^\/v1\/apps\/[^/]+\/appEncryptionDeclarations$/, reason: "Apple answers 404 PATH_ERROR for this relationship. Use /v1/appEncryptionDeclarations?filter[app]=APP_ID." },
  { method: 'GET', path: /^\/v1\/bundleIds\/[^/]+\/bundleIdCapabilities$/, query: 'limit', reason: "Apple rejects 'limit' on this relationship (PARAMETER_ERROR.ILLEGAL). Omit it." },
];
/** Why Apple rejects this request although the catalog lists it, if it does. */
export function appleRejects(method: string, path: string): string | undefined {
  const url = new URL(path, 'https://api.appstoreconnect.apple.com');
  return APPLE_REJECTS.find(rule => rule.method === method && rule.path.test(url.pathname) && (!rule.query || url.searchParams.has(rule.query)))?.reason;
}
/** Accepts only a real GET endpoint from Apple's catalog, so a generic read cannot reach anything else. */
export function assertReadablePath(path: string): void {
  if (!matchEndpoint('GET', path)) throw new Error('Path is not a GET endpoint in the API catalog. Use api_catalog_search.');
  const rejected = appleRejects('GET', path);
  if (rejected) throw new Error(rejected);
}
const SECRET_KEY = /password|secret|private.?key|demoAccountName|certificateContent|profileContent/i;
/** Removes credentials from data shown to a model, whichever endpoint or sparse field set produced it. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) && item !== null ? '[redacted]' : redactSecrets(item)])) as T;
  }
  return value;
}
