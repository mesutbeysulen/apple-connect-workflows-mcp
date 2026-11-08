import type { Resource } from '../src/apple.js';
import { AppleError } from '../src/apple.js';
import type { Account } from '../src/config.js';

export const account: Account = { name: 'team', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: '/unused', readOnly: false, allowedAppIds: ['123'] };
export const readOnly: Account = { ...account, readOnly: true };
export const res = (id: string, type: string, attributes: Record<string, unknown> = {}, relationships?: Resource['relationships']): Resource => ({ id, type, attributes, ...(relationships ? { relationships } : {}) });
export type Call = { method: string; path: string; body?: unknown };
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
      calls.push({ method: 'GET', path });
      const value = find(path);
      if (!value || Array.isArray(value)) throw new AppleError(404, []);
      return value;
    },
    list: async (path: string): Promise<{ data: Resource[]; truncated: boolean }> => {
      calls.push({ method: 'LIST', path });
      const value = find(path);
      return { data: Array.isArray(value) ? value : [], truncated: false };
    },
    post: async (path: string, body: unknown): Promise<Resource> => {
      calls.push({ method: 'POST', path, body });
      return handlers.post?.(path, body) ?? res('new-id', (body as { data: { type: string } }).data.type);
    },
    patch: async (path: string, _type: string, _id: string, attributes: Record<string, unknown>): Promise<unknown> => { calls.push({ method: 'PATCH', path, body: attributes }); return {}; },
    delete: async (path: string): Promise<void> => { calls.push({ method: 'DELETE', path }); },
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
