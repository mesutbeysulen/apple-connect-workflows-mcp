import { readFileSync } from 'node:fs';

export interface Endpoint { method: string; path: string; tag: string; deprecated?: boolean; filters?: string[] }
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
/** Accepts only a real GET endpoint from Apple's catalog, so a generic read cannot reach anything else. */
export function assertReadablePath(path: string): void {
  const url = new URL(path, 'https://api.appstoreconnect.apple.com');
  if (url.origin !== 'https://api.appstoreconnect.apple.com' || !path.startsWith('/')) throw new Error('Use an API path such as /v1/apps.');
  const parts = url.pathname.split('/');
  const known = catalog().endpoints.some(e => {
    if (e.method !== 'GET') return false;
    const template = e.path.split('/');
    return template.length === parts.length && template.every((segment, i) => /^\{.+\}$/.test(segment) ? /^[A-Za-z0-9._-]+$/.test(parts[i]!) : segment === parts[i]);
  });
  if (!known) throw new Error('Path is not a GET endpoint in the API catalog. Use api_catalog_search.');
}
