import { requireWrite, type Account } from './config.js';
import { draftProductVersion, type CommercialAPI } from './commercial.js';
import { readImage, rereadImage } from './screenshots.js';
import { putFilePart, validateOperations } from './upload-transfer.js';

/** Uploads a review image to a draft IAP or subscription metadata version. */
export async function uploadProductVersionImage(input: { account: Account; appId: string; kind: 'iap' | 'subscription'; productId: string; versionId: string; filePath: string }, api: CommercialAPI, fetcher: typeof fetch = fetch): Promise<{ status: 'exists' | 'uploaded'; id: string; state: unknown }> {
  const { account, appId, kind, productId, versionId, filePath } = input;
  requireWrite(account, appId);
  if (kind !== 'iap' && kind !== 'subscription') throw new Error('Use iap or subscription for a product review image.');
  const { name, bytes, sha256 } = await readImage(filePath);
  await draftProductVersion(api, appId, kind, productId, versionId);
  const resource = kind === 'iap' ? 'inAppPurchaseImages' : 'subscriptionImages';
  const versionResource = kind === 'iap' ? 'inAppPurchaseVersions' : 'subscriptionVersions';
  const images = await api.list(`/v1/${versionResource}/${versionId}/images?limit=200`, 2000);
  if (images.truncated) throw new Error('Incomplete product image list; refusing to create a duplicate.');
  const same = images.data.find(row => row.attributes.fileName === name && row.attributes.fileSize === bytes.length);
  if (same) {
    if (same.attributes.uploaded === true) return { status: 'exists', id: same.id, state: same.attributes.assetDeliveryState };
    throw new Error(`Image ${same.id} is already reserved but not uploaded; inspect it before retrying.`);
  }
  const reserved = await api.post(`/v2/${resource}`, { data: { type: resource, attributes: { fileName: name, fileSize: bytes.length },
    relationships: { version: { data: { type: versionResource, id: versionId } } } } });
  for (const op of validateOperations(reserved.attributes.uploadOperations, bytes.length)) await putFilePart(op, filePath, fetcher);
  await rereadImage(filePath, sha256);
  await api.patch(`/v2/${resource}/${reserved.id}`, resource, reserved.id, { uploaded: true });
  const after = await api.get(`/v2/${resource}/${reserved.id}`);
  return { status: 'uploaded', id: reserved.id, state: after.attributes.assetDeliveryState };
}
