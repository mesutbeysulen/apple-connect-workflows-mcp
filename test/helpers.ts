import type { Resource } from '../src/apple.js';
import { AppleError } from '../src/apple.js';
import type { Account } from '../src/config.js';
import { appleRejects, matchEndpoint } from '../src/catalog.js';
import { checkSchema, requestSchema } from '../src/schema-check.js';

/** Every call a test makes must exist in Apple's catalog, use known query parameters and match the request schema. */
export function assertContract(method: string, path: string, body?: unknown): void {
  const endpoint = matchEndpoint(method, path);
  if (!endpoint) throw new Error(`Contract: ${method} ${path.split('?')[0]} is not an Apple endpoint`);
  const rejected = appleRejects(method, path);
  if (rejected) throw new Error(`Contract: ${method} ${path} is rejected by the live API. ${rejected}`);
  for (const key of new URL(path, 'https://x').searchParams.keys()) {
    if (!endpoint.filters?.includes(key)) throw new Error(`Contract: ${method} ${endpoint.path} has no query parameter ${key}`);
  }
  if (endpoint.body) {
    const problems = checkSchema(requestSchema(endpoint.body)!, body);
    if (problems.length) throw new Error(`Contract: ${method} ${endpoint.path} body: ${problems.join('; ')}`);
  } else if (body !== undefined && method !== 'GET') throw new Error(`Contract: ${method} ${endpoint.path} takes no body`);
}

export const account: Account = { name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] };
export const readOnly: Account = { ...account, readOnly: true };
export const res = (id: string, type: string, attributes: Record<string, unknown> = {}, relationships?: Resource['relationships']): Resource => ({ id, type, attributes, ...(relationships ? { relationships } : {}) });
export type Call = { method: string; path: string; body?: unknown };
/** Wraps a hand-written fake so its traffic gets the same Apple contract check. */
export function withContract<T extends object>(api: T): T {
  const fake = api as Record<string, any>;
  const wrapped: Record<string, any> = { ...fake };
  if (fake.get) wrapped.get = (path: string) => { assertContract('GET', path); return fake.get(path); };
  if (fake.list) wrapped.list = (path: string, limit?: number) => { assertContract('GET', path); return fake.list(path, limit); };
  if (fake.post) wrapped.post = (path: string, body: unknown) => { assertContract('POST', path, body); return fake.post(path, body); };
  if (fake.patch) wrapped.patch = (path: string, type: string, id: string, attributes: unknown) => { assertContract('PATCH', path, { data: { type, id, attributes } }); return fake.patch(path, type, id, attributes); };
  if (fake.delete) wrapped.delete = (path: string) => { assertContract('DELETE', path); return fake.delete(path); };
  if (fake.request) wrapped.request = (method: string, path: string, body?: unknown) => { assertContract(method, path, body); return fake.request(method, path, body); };
  return wrapped as T;
}
type Route = Resource | Resource[] | ((path: string) => Resource | Resource[]);
/** Answers each path from the first route whose prefix matches; unknown GETs are 404 like Apple. */
export function fakeApi(routes: Record<string, Route>, handlers: { post?: (path: string, body: any) => Resource } = {}) {
  const calls: Call[] = [];
  const find = (path: string) => {
    const bare = path.split('?')[0]!;
    const route = routes[path] ?? routes[bare];
    return typeof route === 'function' ? route(path) : route;
  };
  return { calls, api: {
    get: async (path: string): Promise<Resource> => {
      assertContract('GET', path);
      calls.push({ method: 'GET', path });
      const value = find(path);
      if (!value || Array.isArray(value)) throw new AppleError(404, []);
      return value;
    },
    list: async (path: string): Promise<{ data: Resource[]; truncated: boolean }> => {
      assertContract('GET', path);
      calls.push({ method: 'LIST', path });
      const value = find(path);
      return { data: Array.isArray(value) ? value : [], truncated: false };
    },
    post: async (path: string, body: unknown): Promise<Resource> => {
      assertContract('POST', path, body);
      calls.push({ method: 'POST', path, body });
      return handlers.post?.(path, body) ?? res('new-id', (body as { data: { type: string } }).data.type);
    },
    patch: async (path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown> => { assertContract('PATCH', path, { data: { type, id, attributes } }); calls.push({ method: 'PATCH', path, body: attributes }); return {}; },
    delete: async (path: string): Promise<void> => { assertContract('DELETE', path); calls.push({ method: 'DELETE', path }); },
    request: async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> => { assertContract(method, path, body); calls.push({ method, path, body }); return {}; },
  }, writes: () => calls.filter(c => !['GET', 'LIST'].includes(c.method)) };
}
export const png = (width: number, height: number, colorType = 2) => {
  const header = Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(header);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20); header[24] = 8; header[25] = colorType;
  const idat = Buffer.alloc(12); idat.write('IDAT', 4, 'latin1');
  return Buffer.concat([header, idat]);
};
