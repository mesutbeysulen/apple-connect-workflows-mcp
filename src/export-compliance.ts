import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { AppleError, type Resource } from './apple.js';
import { validId } from './apple-rules.js';
import { requireWrite, type Account } from './config.js';
import { putFilePart, validateOperations } from './upload-transfer.js';

export interface EncryptionAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
  request(method: 'PATCH', path: string, body: unknown): Promise<unknown>;
}
const rel = (type: string, id: string) => ({ data: { type, id } });
async function optional(api: EncryptionAPI, path: string): Promise<Resource | undefined> {
  try { return await api.get(path); }
  catch (error) { if (error instanceof AppleError && error.status === 404) return undefined; throw error; }
}
async function ownedDeclaration(api: EncryptionAPI, appId: string, declarationId: string): Promise<Resource> {
  if (![appId, declarationId].every(validId)) throw new Error('Invalid app or declaration ID.');
  const app = await api.get(`/v1/appEncryptionDeclarations/${declarationId}/app`);
  if (app.id !== appId) throw new Error('Encryption declaration does not belong to this app.');
  return api.get(`/v1/appEncryptionDeclarations/${declarationId}`);
}
export interface EncryptionAnswers {
  appDescription: string;
  containsProprietaryCryptography: boolean;
  containsThirdPartyCryptography: boolean;
  availableOnFrenchStore: boolean;
}
/** Records the operator's export-compliance answers. Legal classification remains their responsibility. */
export async function createEncryptionDeclaration(input: { account: Account; appId: string } & EncryptionAnswers, api: EncryptionAPI): Promise<{ status: 'exists' | 'created'; id: string; state: unknown }> {
  const { account, appId, ...answers } = input;
  requireWrite(account, appId);
  if (!validId(appId) || !answers.appDescription.trim() || Object.values(answers).some(value => typeof value !== 'string' && typeof value !== 'boolean')) throw new Error('Provide a valid app ID and all export-compliance answers.');
  const current = await api.list(`/v1/apps/${appId}/appEncryptionDeclarations?limit=200`, 2000);
  if (current.truncated) throw new Error('Incomplete encryption declaration list; refusing to create a duplicate.');
  const match = current.data.find(row => Object.entries(answers).every(([field, value]) => row.attributes[field] === value));
  if (match) return { status: 'exists', id: match.id, state: match.attributes.appEncryptionDeclarationState };
  const created = await api.post('/v1/appEncryptionDeclarations', { data: { type: 'appEncryptionDeclarations', attributes: answers, relationships: { app: rel('apps', appId) } } });
  return { status: 'created', id: created.id, state: created.attributes.appEncryptionDeclarationState };
}
/** Uploads the supporting document to a declaration; an existing reservation is never silently duplicated. */
export async function uploadEncryptionDocument(input: { account: Account; appId: string; declarationId: string; filePath: string }, api: EncryptionAPI, fetcher: typeof fetch = fetch): Promise<{ status: 'exists' | 'uploaded'; id: string; state: unknown }> {
  const { account, appId, declarationId, filePath } = input;
  requireWrite(account, appId);
  if (!isAbsolute(filePath)) throw new Error('Use an absolute document path.');
  const file = await stat(filePath);
  if (!file.isFile() || file.size < 1) throw new Error('Document is missing or empty.');
  await ownedDeclaration(api, appId, declarationId);
  const existing = await optional(api, `/v1/appEncryptionDeclarations/${declarationId}/appEncryptionDeclarationDocument`);
  if (existing) {
    if (existing.attributes.uploaded === true && existing.attributes.fileName === basename(filePath) && existing.attributes.fileSize === file.size)
      return { status: 'exists', id: existing.id, state: existing.attributes.assetDeliveryState };
    throw new Error(`Declaration already has document ${existing.id}; inspect it in App Store Connect before replacing or retrying.`);
  }
  const reserved = await api.post('/v1/appEncryptionDeclarationDocuments', { data: { type: 'appEncryptionDeclarationDocuments',
    attributes: { fileName: basename(filePath), fileSize: file.size }, relationships: { appEncryptionDeclaration: rel('appEncryptionDeclarations', declarationId) } } });
  for (const op of validateOperations(reserved.attributes.uploadOperations, file.size)) await putFilePart(op, filePath, fetcher);
  const checksum = createHash('md5').update(await readFile(filePath)).digest('hex');
  await api.patch(`/v1/appEncryptionDeclarationDocuments/${reserved.id}`, 'appEncryptionDeclarationDocuments', reserved.id, { uploaded: true, sourceFileChecksum: checksum });
  const after = await api.get(`/v1/appEncryptionDeclarationDocuments/${reserved.id}`);
  return { status: 'uploaded', id: reserved.id, state: after.attributes.assetDeliveryState };
}
/** Links an Apple-approved declaration to a build owned by the same app. */
export async function attachEncryptionDeclaration(input: { account: Account; appId: string; declarationId: string; buildId: string }, api: EncryptionAPI): Promise<{ status: 'exists' | 'attached'; declarationId: string; buildId: string }> {
  const { account, appId, declarationId, buildId } = input;
  requireWrite(account, appId);
  if (![appId, declarationId, buildId].every(validId)) throw new Error('Invalid app, declaration or build ID.');
  const declaration = await ownedDeclaration(api, appId, declarationId);
  if (declaration.attributes.appEncryptionDeclarationState !== 'APPROVED') throw new Error('Apple must approve the encryption declaration before it is attached to a build.');
  if ((await api.get(`/v1/builds/${buildId}/app`)).id !== appId) throw new Error('Build does not belong to this app.');
  const existing = await optional(api, `/v1/builds/${buildId}/appEncryptionDeclaration`);
  if (existing?.id === declarationId) return { status: 'exists', declarationId, buildId };
  if (existing) throw new Error(`Build already has another encryption declaration (${existing.id}).`);
  await api.request('PATCH', `/v1/builds/${buildId}/relationships/appEncryptionDeclaration`, { data: { type: 'appEncryptionDeclarations', id: declarationId } });
  const after = await api.get(`/v1/builds/${buildId}/appEncryptionDeclaration`);
  if (after.id !== declarationId) throw new Error('Apple did not confirm the build encryption declaration link.');
  return { status: 'attached', declarationId, buildId };
}
