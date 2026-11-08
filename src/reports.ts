import { createHash, randomUUID } from 'node:crypto';
import { rename, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';

const MAX_REPORT_BYTES = 1024 * 1024 * 1024;
export interface ReportAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  download(path: string, accept: string): Promise<Buffer>;
}
const gunzip = (bytes: Buffer) => bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_REPORT_BYTES }) : bytes;
/** Merges TSV reports whose columns may differ, keeping every column and tagging each row's source. */
export function mergeTsv(parts: { source: string; text: string }[], sourceColumn: string): { text: string; rows: number } {
  const columns: string[] = [];
  const rows: Map<string, string>[] = [];
  for (const { source, text } of parts) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    const header = lines[0]?.split('\t');
    if (!header) continue;
    for (const column of header) if (!columns.includes(column)) columns.push(column);
    for (const line of lines.slice(1)) {
      // Apple footers such as "Total_Rows" are not data rows.
      if (!line.includes('\t')) continue;
      const cells = line.split('\t');
      rows.push(new Map([[sourceColumn, source], ...header.map((column, i) => [column, cells[i] ?? ''] as [string, string])]));
    }
  }
  const all = [sourceColumn, ...columns];
  return { text: `${[all.join('\t'), ...rows.map(row => all.map(c => row.get(c) ?? '').join('\t'))].join('\n')}\n`, rows: rows.length };
}
async function writeOutput(path: string, text: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('--out must be an absolute path.');
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
export function reportPeriods(frequency: string, from: string, to: string): string[] {
  const parse = (value: string) => { const date = new Date(`${value}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) throw new Error('Dates must be YYYY-MM-DD.'); return date; };
  const start = parse(from); const end = parse(to);
  if (start > end) throw new Error('--from must not be after --to.');
  const periods = new Set<string>();
  for (const at = new Date(start); at <= end; at.setUTCDate(at.getUTCDate() + 1)) {
    const day = at.toISOString().slice(0, 10);
    if (frequency === 'DAILY') periods.add(day);
    // Apple's weekly reports are addressed by the week's Sunday.
    else if (frequency === 'WEEKLY') { if (at.getUTCDay() === 0) periods.add(day); }
    else if (frequency === 'MONTHLY') periods.add(day.slice(0, 7));
    else if (frequency === 'YEARLY') periods.add(day.slice(0, 4));
    else throw new Error('Frequency must be DAILY, WEEKLY, MONTHLY or YEARLY.');
  }
  if (!periods.size) throw new Error('This date range contains no report period.');
  if (periods.size > 400) throw new Error('Range is limited to 400 report periods.');
  return [...periods];
}
export interface SalesInput { vendorNumber: string; reportType: string; reportSubType: string; frequency: string; from: string; to: string; version?: string; out: string }
/** Downloads a range of sales reports and merges them. Periods Apple has no data for are listed, not hidden. */
export async function downloadSales(input: SalesInput, api: ReportAPI): Promise<{ out: string; rows: number; downloaded: string[]; missing: string[] }> {
  const { vendorNumber, reportType, reportSubType, frequency, from, to, version, out } = input;
  if (!/^\d{1,20}$/.test(vendorNumber)) throw new Error('Vendor number must be numeric.');
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
  const parts: { source: string; text: string }[] = [];
  const missing: string[] = [];
  for (const period of reportPeriods(frequency, from, to)) {
    const query = new URLSearchParams({ 'filter[vendorNumber]': vendorNumber, 'filter[reportType]': reportType, 'filter[reportSubType]': reportSubType, 'filter[frequency]': frequency, 'filter[reportDate]': period, ...(version ? { 'filter[version]': version } : {}) });
    try { parts.push({ source: period, text: gunzip(await api.download(`/v1/salesReports?${query}`, 'application/a-gzip')).toString('utf8') }); }
    catch (error) { if (error instanceof AppleError && error.status === 404) { missing.push(period); continue; } throw error; }
  }
  const merged = mergeTsv(parts, 'report_period');
  await writeOutput(out, merged.text);
  return { out, rows: merged.rows, downloaded: parts.map(p => p.source), missing };
}
/** Opens analytics report access for an app. Apple needs time before the first instances appear. */
export async function requestAnalytics(input: { account: Account; appId: string; accessType: 'ONGOING' | 'ONE_TIME_SNAPSHOT' }, api: ReportAPI): Promise<{ status: 'exists' | 'created'; requestId: string }> {
  const { account, appId, accessType } = input;
  requireWrite(account, appId);
  const existing = await api.list(`/v1/apps/${appId}/analyticsReportRequests?limit=200`, 200);
  const found = existing.data.find(row => row.attributes.accessType === accessType && row.attributes.stoppedDueToInactivity !== true);
  if (found) return { status: 'exists', requestId: found.id };
  const created = await api.post('/v1/analyticsReportRequests', { data: { type: 'analyticsReportRequests', attributes: { accessType }, relationships: { app: { data: { type: 'apps', id: appId } } } } });
  return { status: 'created', requestId: created.id };
}
export interface AnalyticsInput { appId: string; reportName: string; category?: string; granularity: string; from?: string; to?: string; out: string }
/** Downloads every segment of matching report instances, verifies size and MD5, and merges them. */
export async function downloadAnalytics(input: AnalyticsInput, api: ReportAPI, fetcher: typeof fetch = fetch): Promise<{ out: string; rows: number; instances: string[] }> {
  const { appId, reportName, category, granularity, from, to, out } = input;
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
  const requests = await api.list(`/v1/apps/${appId}/analyticsReportRequests?limit=200`, 200);
  if (!requests.data.length) throw new Error('No analytics report request exists. Run analytics-request first.');
  const parts: { source: string; text: string }[] = [];
  const instancesSeen = new Set<string>();
  for (const request of requests.data) {
    const reportQuery = new URLSearchParams({ 'filter[name]': reportName, limit: '200', ...(category ? { 'filter[category]': category } : {}) });
    const reports = await api.list(`/v1/analyticsReportRequests/${request.id}/reports?${reportQuery}`, 200);
    for (const report of reports.data) {
      const instances = await api.list(`/v1/analyticsReports/${report.id}/instances?${new URLSearchParams({ 'filter[granularity]': granularity, limit: '200' })}`, 2000);
      for (const instance of instances.data) {
        const date = String(instance.attributes.processingDate ?? '');
        if ((from && date < from) || (to && date > to) || instancesSeen.has(instance.id)) continue;
        instancesSeen.add(instance.id);
        const segments = await api.list(`/v1/analyticsReportInstances/${instance.id}/segments?limit=200`, 2000);
        if (segments.truncated) throw new Error('Incomplete analytics segment list.');
        for (const segment of segments.data) {
          const url = new URL(String(segment.attributes.url));
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe analytics segment URL.');
          // Pre-signed URL: API credentials are deliberately not sent.
          const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
          if (!response.ok) throw new Error(`Analytics segment download failed: HTTP ${response.status}.`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const checksum = segment.attributes.checksum;
          if (typeof checksum === 'string' && createHash('md5').update(bytes).digest('hex') !== checksum) throw new Error(`Analytics segment ${segment.id} failed checksum verification.`);
          parts.push({ source: date, text: gunzip(bytes).toString('utf8') });
        }
      }
    }
  }
  if (!parts.length) throw new Error('No analytics data matched. New report requests can take a day or more to produce instances.');
  const merged = mergeTsv(parts, 'processing_date');
  await writeOutput(out, merged.text);
  return { out, rows: merged.rows, instances: [...instancesSeen] };
}
