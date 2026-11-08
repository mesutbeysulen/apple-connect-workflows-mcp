import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEncryptionDeclaration, uploadEncryptionDocument, attachEncryptionDeclaration } from '../src/export-compliance.js';
import { account, readOnly, res, fakeApi, assertContract } from './helpers.js';

const answers = { appDescription: 'Encrypted local records', containsProprietaryCryptography: false,
  containsThirdPartyCryptography: true, availableOnFrenchStore: true };
const base = {
  '/v1/apps/123/appEncryptionDeclarations': [],
  '/v1/appEncryptionDeclarations/d/app': res('123', 'apps'),
  '/v1/appEncryptionDeclarations/d': res('d', 'appEncryptionDeclarations', { appEncryptionDeclarationState: 'APPROVED' }),
  '/v1/builds/b/app': res('123', 'apps'),
};
test('encryption declaration checks ownership and is idempotent', async () => {
  const f = fakeApi(base);
  const created = await createEncryptionDeclaration({ account, appId: '123', ...answers }, f.api);
  assert.equal(created.status, 'created');
  assert.equal((f.writes()[0]!.body as any).data.relationships.app.data.id, '123');
  const existing = fakeApi({ ...base, '/v1/apps/123/appEncryptionDeclarations': [res('d', 'appEncryptionDeclarations', answers)] });
  assert.equal((await createEncryptionDeclaration({ account, appId: '123', ...answers }, existing.api)).status, 'exists');
  assert.equal(existing.writes().length, 0);
  await assert.rejects(createEncryptionDeclaration({ account: readOnly, appId: '123', ...answers }, f.api), /read-only/);
});
test('document upload reserves, transfers and commits without duplicating an existing document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-crypto-'));
  const filePath = join(dir, 'export.pdf');
  writeFileSync(filePath, 'document');
  try {
    const f = fakeApi({ ...base, '/v1/appEncryptionDeclarations/d/appEncryptionDeclarationDocument': undefined as never,
      '/v1/appEncryptionDeclarationDocuments/doc': res('doc', 'appEncryptionDeclarationDocuments', { assetDeliveryState: { state: 'COMPLETE' } }) }, {
      post: () => res('doc', 'appEncryptionDeclarationDocuments', { uploadOperations: [{ method: 'PUT', url: 'https://upload.apple.com/file', offset: 0, length: 8, requestHeaders: [] }] }),
    });
    let transferred = false;
    const fetcher = async (_url: any, options: any) => { transferred = true; assert.equal(options.method, 'PUT'); return new Response(null, { status: 200 }); };
    const result = await uploadEncryptionDocument({ account, appId: '123', declarationId: 'd', filePath }, f.api, fetcher as typeof fetch);
    assert.equal(result.status, 'uploaded'); assert.equal(transferred, true);
    assert.equal(f.writes().length, 2);
    assert.equal(f.writes()[1]!.path, '/v1/appEncryptionDeclarationDocuments/doc');
    const occupied = fakeApi({ ...base, '/v1/appEncryptionDeclarations/d/appEncryptionDeclarationDocument': res('other', 'appEncryptionDeclarationDocuments', { uploaded: false }) });
    await assert.rejects(uploadEncryptionDocument({ account, appId: '123', declarationId: 'd', filePath }, occupied.api), /already has document/);
    assert.equal(occupied.writes().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('only approved declarations can be attached to a build of the same app', async () => {
  let attached = false;
  const f = fakeApi(base);
  const api = { ...f.api, get: async (path: string) => {
    if (path === '/v1/builds/b/appEncryptionDeclaration') {
      assertContract('GET', path);
      if (attached) return res('d', 'appEncryptionDeclarations');
    }
    return f.api.get(path);
  }, request: async (method: 'PATCH', path: string, body: unknown) => { await f.api.request(method, path, body); attached = true; } };
  assert.equal((await attachEncryptionDeclaration({ account, appId: '123', declarationId: 'd', buildId: 'b' }, api)).status, 'attached');
  assert.equal((await attachEncryptionDeclaration({ account, appId: '123', declarationId: 'd', buildId: 'b' }, api)).status, 'exists');
  assert.equal(f.writes().length, 1);
  const pending = fakeApi({ ...base, '/v1/appEncryptionDeclarations/d': res('d', 'appEncryptionDeclarations', { appEncryptionDeclarationState: 'IN_REVIEW' }) });
  await assert.rejects(attachEncryptionDeclaration({ account, appId: '123', declarationId: 'd', buildId: 'b' }, pending.api), /must approve/);
  assert.equal(pending.writes().length, 0);
});
