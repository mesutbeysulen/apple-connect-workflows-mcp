import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadProductVersionImage } from '../src/product-images.js';
import { account, res, fakeApi } from './helpers.js';

test('version image upload verifies app ownership, transfers bytes and commits once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-product-image-'));
  const filePath = join(dir, 'review.png');
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  writeFileSync(filePath, bytes);
  try {
    const routes = {
      '/v1/apps/123/inAppPurchasesV2': [res('iap', 'inAppPurchases')],
      '/v2/inAppPurchases/iap/versions': [res('iv', 'inAppPurchaseVersions', { state: 'PREPARE_FOR_SUBMISSION' })],
      '/v1/inAppPurchaseVersions/iv/images': [],
      '/v2/inAppPurchaseImages/img': res('img', 'inAppPurchaseImages', { assetDeliveryState: { state: 'COMPLETE' } }),
    };
    const f = fakeApi(routes, { post: () => res('img', 'inAppPurchaseImages', { uploadOperations: [{ method: 'PUT', url: 'https://upload.apple.com/file', offset: 0, length: bytes.length, requestHeaders: [] }] }) });
    let put = false;
    const fetcher = async (_url: any, options: any) => { put = true; assert.equal(options.method, 'PUT'); return new Response(null, { status: 200 }); };
    const input = { account, appId: '123', kind: 'iap' as const, productId: 'iap', versionId: 'iv', filePath };
    assert.equal((await uploadProductVersionImage(input, f.api, fetcher as typeof fetch)).status, 'uploaded');
    assert.equal(put, true);
    assert.equal((f.writes()[0]!.body as any).data.relationships.version.data.id, 'iv');
    assert.equal(f.writes()[1]!.path, '/v2/inAppPurchaseImages/img');
    const existing = fakeApi({ ...routes, '/v1/inAppPurchaseVersions/iv/images': [res('img', 'inAppPurchaseImages', { fileName: 'review.png', fileSize: bytes.length, uploaded: true })] });
    assert.equal((await uploadProductVersionImage(input, existing.api)).status, 'exists');
    assert.equal(existing.writes().length, 0);
    const foreign = fakeApi({ ...routes, '/v2/inAppPurchases/iap/versions': [] });
    await assert.rejects(uploadProductVersionImage(input, foreign.api), /does not belong/);
    assert.equal(foreign.writes().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
