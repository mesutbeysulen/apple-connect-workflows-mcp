import { createReadStream } from 'node:fs';

export interface UploadOperation { method: string; url: string; offset: number; length: number; expiration?: string; requestHeaders: { name: string; value: string }[] }
/** Checks Apple's upload instructions before any byte moves, and returns them in file order. */
export function validateOperations(input: unknown, length: number): UploadOperation[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Apple provided no upload operations.');
  const operations = [...input as UploadOperation[]].sort((a, b) => a.offset - b.offset);
  let position = 0;
  for (const op of operations) {
    const url = new URL(op.url);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.apple.com')) throw new Error('Unsafe Apple upload URL.');
    if (op.method !== 'PUT' || !Number.isSafeInteger(op.offset) || !Number.isSafeInteger(op.length) || op.length <= 0 || op.offset !== position) throw new Error('Invalid upload byte ranges.');
    if (!Array.isArray(op.requestHeaders) || op.requestHeaders.some(h => /^(authorization|cookie|host)$/i.test(h.name))) throw new Error('Unsafe upload headers.');
    position += op.length;
  }
  if (position !== length) throw new Error('Upload instructions do not cover the whole file.');
  return operations;
}
/**
 * Streams one byte range of a file to a signed URL. Content-Length is declared because a stream body
 * would otherwise go out chunked, which object stores commonly refuse. API credentials are never sent.
 */
export async function putFilePart(op: Pick<UploadOperation, 'url' | 'offset' | 'length' | 'requestHeaders'>, filePath: string, fetcher: typeof fetch): Promise<void> {
  const headers = Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value]));
  if (!op.requestHeaders.some(h => /^content-length$/i.test(h.name))) headers['content-length'] = String(op.length);
  const response = await fetcher(op.url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10 * 60_000), headers,
    body: createReadStream(filePath, { start: op.offset, end: op.offset + op.length - 1 }), duplex: 'half' } as unknown as RequestInit);
  if (!response.ok) throw new Error(`File transfer failed: HTTP ${response.status}. Signed URL may have expired.`);
  await response.body?.cancel();
}
