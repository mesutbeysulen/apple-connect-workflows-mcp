import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';

/** Upper bound on decompressed report data held on disk during one merge. */
const MAX_REPORT_BYTES = 20 * 1024 * 1024 * 1024;
export interface ReportAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  download(path: string, accept: string): Promise<Buffer>;
}
/**
 * Merges TSV reports whose columns may differ, keeping every column and tagging each row's source.
 * Parts are spooled to a private folder next to the output, so long ranges do not sit in memory.
 */
export class ReportSpool {
  private parts: { source: string; path: string; header: string[] }[] = [];
  private columns: string[] = [];
  private bytes = 0;
  private constructor(private dir: string, private sourceColumn: string) {}
  /** Fails right away if the output folder is unusable, before any download starts. */
  static async open(out: string, sourceColumn: string): Promise<ReportSpool> {
    if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
    return new ReportSpool(await mkdtemp(join(dirname(out), '.report-')), sourceColumn);
  }
  get size(): number { return this.parts.length; }
  async add(source: string, bytes: Buffer): Promise<void> {
    const path = join(this.dir, `${this.parts.length}.tsv`);
    const zipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    await pipeline(Readable.from([bytes]), ...(zipped ? [createGunzip()] : []), createWriteStream(path, { mode: 0o600 }));
    this.bytes += (await stat(path)).size;
    if (this.bytes > MAX_REPORT_BYTES) throw new Error('Report data exceeds the 20 GiB merge limit; use a shorter range.');
    let header: string[] | undefined;
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (line.trim()) { header = line.split('\t'); break; }
    }
    if (!header) return;
    for (const column of header) if (!this.columns.includes(column)) this.columns.push(column);
    this.parts.push({ source, path, header });
  }
  /** Writes the merged file atomically and readable only by its owner. */
  async write(out: string): Promise<number> {
    const temporary = join(this.dir, `${randomUUID()}.out`);
    const output = createWriteStream(temporary, { mode: 0o600 });
    const put = async (text: string) => { if (!output.write(text)) await once(output, 'drain'); };
    let rows = 0;
    try {
      await put(`${[this.sourceColumn, ...this.columns].join('\t')}\n`);
      for (const part of this.parts) {
        let first = true;
        for await (const line of createInterface({ input: createReadStream(part.path), crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          if (first) { first = false; continue; }
          // Apple footers such as "Total_Rows" are not data rows.
          if (!line.includes('\t')) continue;
          const cells = line.split('\t');
          const row = new Map(part.header.map((column, i) => [column, cells[i] ?? '']));
          await put(`${[part.source, ...this.columns.map(c => row.get(c) ?? '')].join('\t')}\n`);
          rows++;
        }
      }
      output.end();
      await once(output, 'finish');
      await rename(temporary, out);
      return rows;
    } catch (error) { output.destroy(); throw error; }
  }
  async close(): Promise<void> { await rm(this.dir, { recursive: true, force: true }); }
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
export async function downloadSales(input: SalesInput, api: ReportAPI): Promise<{ out: string | null; rows: number; downloaded: string[]; missing: string[]; note?: string }> {
  const { vendorNumber, reportType, reportSubType, frequency, from, to, version, out } = input;
  if (!/^\d{1,20}$/.test(vendorNumber)) throw new Error('Vendor number must be numeric.');
  const periods = reportPeriods(frequency, from, to);
  const spool = await ReportSpool.open(out, 'report_period');
  const downloaded: string[] = [];
  const missing: string[] = [];
  try {
    for (const period of periods) {
      const query = new URLSearchParams({ 'filter[vendorNumber]': vendorNumber, 'filter[reportType]': reportType, 'filter[reportSubType]': reportSubType, 'filter[frequency]': frequency, 'filter[reportDate]': period, ...(version ? { 'filter[version]': version } : {}) });
      try { await spool.add(period, await api.download(`/v1/salesReports?${query}`, 'application/a-gzip')); downloaded.push(period); }
      catch (error) {
        if (error instanceof AppleError && error.status === 404) { missing.push(period); continue; }
        // Keep finished periods out of the real output, but do not throw them away.
        if (!spool.size) throw error;
        const partial = `${out}.partial`;
        await spool.write(partial);
        throw new Error(`${error instanceof Error ? error.message : 'Download failed'} Stopped at ${period}; ${downloaded.length} earlier period(s) saved to ${partial}.`);
      }
    }
    // An unpublished range must not wipe out a file from an earlier run.
    if (!spool.size) return { out: null, rows: 0, downloaded, missing, note: 'Apple has no data for this range; no file was written.' };
    return { out, rows: await spool.write(out), downloaded, missing };
  } finally { await spool.close(); }
}
export interface FinanceInput { vendorNumber: string; reportType: string; regionCode: string; from: string; to: string; out: string }
/** Downloads monthly finance reports (Apple fiscal months, YYYY-MM) and merges them like sales reports. */
export async function downloadFinance(input: FinanceInput, api: ReportAPI): Promise<{ out: string | null; rows: number; downloaded: string[]; missing: string[]; note?: string }> {
  const { vendorNumber, reportType, regionCode, from, to, out } = input;
  if (!/^\d{1,20}$/.test(vendorNumber)) throw new Error('Vendor number must be numeric.');
  if (!['FINANCIAL', 'FINANCE_DETAIL'].includes(reportType)) throw new Error('Finance report type must be FINANCIAL or FINANCE_DETAIL.');
  if (!/^[A-Z0-9]{2}$/.test(regionCode)) throw new Error('Region code must be two letters or digits, such as ZZ or US.');
  if (![from, to].every(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) throw new Error('--from and --to must be fiscal months as YYYY-MM.');
  const months = reportPeriods('MONTHLY', `${from}-01`, `${to}-01`);
  const spool = await ReportSpool.open(out, 'fiscal_month');
  const downloaded: string[] = [];
  const missing: string[] = [];
  try {
    for (const month of months) {
      const query = new URLSearchParams({ 'filter[vendorNumber]': vendorNumber, 'filter[reportType]': reportType, 'filter[regionCode]': regionCode, 'filter[reportDate]': month });
      try { await spool.add(month, await api.download(`/v1/financeReports?${query}`, 'application/a-gzip')); downloaded.push(month); }
      catch (error) {
        if (error instanceof AppleError && error.status === 404) { missing.push(month); continue; }
        if (!spool.size) throw error;
        const partial = `${out}.partial`;
        await spool.write(partial);
        throw new Error(`${error instanceof Error ? error.message : 'Download failed'} Stopped at ${month}; ${downloaded.length} earlier month(s) saved to ${partial}.`);
      }
    }
    if (!spool.size) return { out: null, rows: 0, downloaded, missing, note: 'Apple has no finance data for this range; no file was written.' };
    return { out, rows: await spool.write(out), downloaded, missing };
  } finally { await spool.close(); }
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
export async function downloadAnalytics(input: AnalyticsInput, api: ReportAPI, fetcher: typeof fetch = fetch): Promise<{ out: string; rows: number; instances: string[]; overlappingInstancesSkipped: number }> {
  const { appId, reportName, category, granularity, from, to, out } = input;
  const complete = <T extends { truncated: boolean }>(result: T, what: string): T => { if (result.truncated) throw new Error(`Incomplete analytics ${what} list; refusing a partial merge.`); return result; };
  const requests = complete(await api.list(`/v1/apps/${appId}/analyticsReportRequests?limit=200`, 200), 'request');
  if (!requests.data.length) throw new Error('No analytics report request exists. Run analytics-request first.');
  // Ongoing and snapshot requests expose the same days under different IDs; ongoing wins so totals are not doubled.
  const ordered = [...requests.data].sort((a, b) => Number(b.attributes.accessType === 'ONGOING') - Number(a.attributes.accessType === 'ONGOING'));
  const owners = new Map<string, string>();
  const instancesSeen = new Set<string>();
  let skipped = 0;
  const spool = await ReportSpool.open(out, 'processing_date');
  try {
    for (const request of ordered) {
      const reportQuery = new URLSearchParams({ 'filter[name]': reportName, limit: '200', ...(category ? { 'filter[category]': category } : {}) });
      const reports = complete(await api.list(`/v1/analyticsReportRequests/${request.id}/reports?${reportQuery}`, 200), 'report');
      for (const report of reports.data) {
        const instances = complete(await api.list(`/v1/analyticsReports/${report.id}/instances?${new URLSearchParams({ 'filter[granularity]': granularity, limit: '200' })}`, 2000), 'instance');
        for (const instance of instances.data) {
          const date = String(instance.attributes.processingDate ?? '');
          if ((from && date < from) || (to && date > to) || instancesSeen.has(instance.id)) continue;
          const key = `${report.attributes.name ?? reportName}|${granularity}|${date}`;
          const owner = owners.get(key);
          if (owner && owner !== request.id) { skipped++; continue; }
          owners.set(key, request.id);
          instancesSeen.add(instance.id);
          const segments = complete(await api.list(`/v1/analyticsReportInstances/${instance.id}/segments?limit=200`, 2000), 'segment');
          for (const segment of segments.data) {
            const url = new URL(String(segment.attributes.url));
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe analytics segment URL.');
            // Pre-signed URL: API credentials are deliberately not sent.
            const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
            if (!response.ok) throw new Error(`Analytics segment download failed: HTTP ${response.status}.`);
            const bytes = Buffer.from(await response.arrayBuffer());
            const checksum = segment.attributes.checksum;
            if (typeof checksum === 'string' && createHash('md5').update(bytes).digest('hex') !== checksum) throw new Error(`Analytics segment ${segment.id} failed checksum verification.`);
            await spool.add(date, bytes);
          }
        }
      }
    }
    if (!spool.size) throw new Error('No analytics data matched. New report requests can take a day or more to produce instances.');
    return { out, rows: await spool.write(out), instances: [...instancesSeen], overlappingInstancesSkipped: skipped };
  } finally { await spool.close(); }
}
