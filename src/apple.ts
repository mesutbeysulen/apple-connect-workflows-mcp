import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import type { Account } from './config.js';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
export interface Resource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  /** Present when Apple returns relationship linkage, e.g. with ?include=. */
  relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] | null }>;
}
export interface AppleAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
}
export type Method = 'GET' | 'PATCH' | 'POST' | 'DELETE';
export function createTokenProvider(account: Account): () => string {
  let cached: { token: string; expires: number } | undefined;
  return () => {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.expires > now + 60) return cached.token;
    const key = createPrivateKey(readFileSync(account.privateKeyPath));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Apple API key must be an ES256 (P-256) private key.');
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const expires = now + 600;
    const input = `${encode({ alg: 'ES256', kid: account.keyId, typ: 'JWT' })}.${encode({ iss: account.issuerId, iat: now, exp: expires, aud: 'appstoreconnect-v1' })}`;
    const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    cached = { token: `${input}.${signature}`, expires };
    return cached.token;
  };
}
export class AppleError extends Error {
  constructor(public status: number, public codes: string[]) {
    super(`Apple API HTTP ${status}${codes.length ? ` (${codes.join(', ')})` : ''}. ${
      status === 401 ? 'Check team key, issuer and system clock.' :
      status === 403 ? 'Check API role and app access.' :
      status === 409 ? 'Resource state conflicts with this operation.' :
      status === 429 ? 'Rate limited; retry later.' : 'Inspect account/resource state and retry explicitly.'}`);
  }
}
export class AppleClient implements AppleAPI {
  constructor(private token: () => string, private fetcher: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  private url(path: string): URL {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || !/^\/v[1-9]\//.test(url.pathname)) {
      throw new Error('Refusing an API URL outside the allowed Apple origin and versioned API path.');
    }
    return url;
  }
  async request(method: Method, path: string, body?: unknown): Promise<any> {
    const url = this.url(path);
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${this.token()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Mutations are never blindly retried: their outcome may already exist remotely.
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? 2 ** attempt : Number(retry);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry!) - Date.now();
        await response.body?.cancel();
        await this.sleep(Math.max(0, Math.min(30_000, Number.isFinite(delay) ? delay : 1000)));
        continue;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { errors?: { code?: string }[] };
        throw new AppleError(response.status, (data.errors ?? []).map(e => e.code ?? '').filter(Boolean));
      }
      if (response.status === 204) return {};
      return response.json();
    }
  }
  /** Reads a binary API response (e.g. gzip sales reports) with the same origin and credential rules. */
  async download(path: string, accept: string): Promise<Buffer> {
    const url = this.url(path);
    const response = await this.fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${this.token()}`, accept } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { errors?: { code?: string }[] };
      throw new AppleError(response.status, (data.errors ?? []).map(e => e.code ?? '').filter(Boolean));
    }
    return Buffer.from(await response.arrayBuffer());
  }
  async post(path: string, body: unknown): Promise<Resource> { return (await this.request('POST', path, body)).data; }
  async delete(path: string): Promise<void> { await this.request('DELETE', path); }
  async get(path: string): Promise<Resource> { return (await this.request('GET', path)).data; }
  async patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', path, { data: { type, id, attributes } });
  }
  async list(path: string, limit = 200): Promise<{ data: Resource[]; truncated: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('Limit must be between 1 and 2000.');
    const rows: Resource[] = [];
    const visited = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      const url = this.url(next).toString();
      if (visited.has(url)) throw new Error('Apple pagination cycle detected; result is incomplete.');
      visited.add(url);
      const page = await this.request('GET', url);
      if (!Array.isArray(page.data)) throw new Error('Invalid Apple collection response.');
      rows.push(...page.data);
      next = page.links?.next || undefined;
      if (rows.length >= limit) return { data: rows.slice(0, limit), truncated: rows.length > limit || !!next };
      if (visited.size >= 50 && next) throw new Error('Pagination budget exceeded; result is incomplete.');
    }
    return { data: rows, truncated: false };
  }
}
