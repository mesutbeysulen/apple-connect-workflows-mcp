import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type Changes = Record<string, string>;
export interface Step { localizationId: string; locale: string; before: Record<string, unknown>; after: Changes }
export interface PlanBody {
  account: string; identity: string; appId: string; versionId: string;
  createdAt: number; expiresAt: number; steps: Step[];
}
export interface Plan { id: string; digest: string; body: PlanBody; status: string; completed: string[]; error: string | null }
export const digest = (body: PlanBody) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
export interface ScreenshotJob {
  id: string; account: string; identity: string; appId: string; versionId: string;
  localizationId: string; setId: string; filePath: string; sha256: string;
  /** Absent on jobs recorded before cleanup support; such jobs are never auto-deleted. */
  createdAt?: number;
  status: string; error: string | null;
}
/** Local journal of an Asset Library image upload and its placement on a version localization. */
export interface AssetJob {
  id: string; account: string; identity: string; appId: string; versionId: string;
  localizationId: string; placementType: string; placementGroup: string;
  filePath: string; sha256: string; createdAt: number;
  placementId: string | null; status: string; error: string | null;
}
/** Local journal of an IPA upload; doneParts holds byte offsets Apple already accepted. */
export interface BuildJob {
  id: string; account: string; identity: string; appId: string; version: string; build: string;
  filePath: string; sha256: string; size: number; createdAt: number;
  fileId: string | null; doneParts: number[]; status: string; error: string | null;
}
/** Local journal of a standalone creative asset upload (no placement yet). */
export interface CreativeJob {
  id: string; kind: 'image' | 'video'; account: string; identity: string; appId: string;
  filePath: string; sha256: string; size: number; createdAt: number; status: string; error: string | null;
}
export class PlanStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', completed TEXT NOT NULL DEFAULT '[]', error TEXT
      );
      CREATE TABLE IF NOT EXISTS leases (scope TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS screenshot_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS build_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, file_id TEXT, done_parts TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS creative_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, at INTEGER NOT NULL, os_user TEXT NOT NULL, command TEXT NOT NULL, account TEXT, app_id TEXT, ok INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS asset_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, placement_id TEXT, status TEXT NOT NULL, error TEXT);`);
  }
  create(body: PlanBody): Plan {
    const id = randomUUID();
    this.db.prepare('INSERT INTO plans(id,digest,body) VALUES (?,?,?)').run(id, digest(body), JSON.stringify(body));
    return this.get(id);
  }
  get(id: string): Plan {
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(id) as Record<string, any> | undefined;
    if (!row) throw new Error('Plan not found.');
    const body = JSON.parse(row.body) as PlanBody;
    if (digest(body) !== row.digest) throw new Error('Plan integrity check failed.');
    return { id, digest: row.digest, body, status: row.status, completed: JSON.parse(row.completed), error: row.error };
  }
  acquire(plan: Plan): { scope: string; owner: string } {
    const scope = `${plan.body.identity}:${plan.body.appId}`;
    const owner = randomUUID();
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO leases(scope,owner,expires) VALUES (?,?,?)
      ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE leases.expires < ?`)
      .run(scope, owner, now + 300_000, now);
    if (!result.changes) throw new Error('Another operation is active for this account/app. Retry after it finishes or its five-minute lease expires.');
    return { scope, owner };
  }
  heartbeat(lease: { scope: string; owner: string }): void {
    const result = this.db.prepare('UPDATE leases SET expires=? WHERE scope=? AND owner=? AND expires>=?')
      .run(Date.now() + 300_000, lease.scope, lease.owner, Date.now());
    if (!result.changes) throw new Error('Execution lease lost.');
  }
  release(lease: { scope: string; owner: string }): void {
    this.db.prepare('DELETE FROM leases WHERE scope=? AND owner=?').run(lease.scope, lease.owner);
  }
  update(id: string, status: string, completed: string[], error: string | null = null): void {
    this.db.prepare('UPDATE plans SET status=?,completed=?,error=? WHERE id=?').run(status, JSON.stringify(completed), error, id);
  }
  saveScreenshot(job: ScreenshotJob): void {
    const { status, error, ...body } = job;
    this.db.prepare(`INSERT INTO screenshot_jobs(id,body,status,error) VALUES (?,?,?,?)`).run(job.id, JSON.stringify(body), status, error);
  }
  screenshot(id: string): ScreenshotJob {
    const row = this.db.prepare('SELECT body,status,error FROM screenshot_jobs WHERE id=?').get(id) as { body: string; status: string; error: string | null } | undefined;
    if (!row) throw new Error('Screenshot job not found.');
    return { ...JSON.parse(row.body), status: row.status, error: row.error } as ScreenshotJob;
  }
  updateScreenshot(id: string, status: string, error: string | null = null): void {
    this.db.prepare('UPDATE screenshot_jobs SET status=?,error=? WHERE id=?').run(status, error, id);
  }
  screenshotJobs(account: string, appId: string): ScreenshotJob[] {
    const rows = this.db.prepare('SELECT id FROM screenshot_jobs').all() as { id: string }[];
    return rows.map(r => this.screenshot(r.id)).filter(j => j.account === account && j.appId === appId);
  }
  saveAsset(job: AssetJob): void {
    const { status, error, placementId, ...body } = job;
    this.db.prepare('INSERT INTO asset_jobs(id,body,placement_id,status,error) VALUES (?,?,?,?,?)').run(job.id, JSON.stringify(body), placementId, status, error);
  }
  asset(id: string): AssetJob {
    const row = this.db.prepare('SELECT body,placement_id,status,error FROM asset_jobs WHERE id=?').get(id) as { body: string; placement_id: string | null; status: string; error: string | null } | undefined;
    if (!row) throw new Error('Asset job not found.');
    return { ...JSON.parse(row.body), placementId: row.placement_id, status: row.status, error: row.error } as AssetJob;
  }
  hasAsset(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM asset_jobs WHERE id=?').get(id);
  }
  updateAsset(id: string, status: string, error: string | null = null, placementId?: string): void {
    if (placementId !== undefined) this.db.prepare('UPDATE asset_jobs SET placement_id=? WHERE id=?').run(placementId, id);
    this.db.prepare('UPDATE asset_jobs SET status=?,error=? WHERE id=?').run(status, error, id);
  }
  saveBuild(job: BuildJob): void {
    const { status, error, fileId, doneParts, ...body } = job;
    this.db.prepare('INSERT INTO build_jobs(id,body,file_id,done_parts,status,error) VALUES (?,?,?,?,?,?)').run(job.id, JSON.stringify(body), fileId, JSON.stringify(doneParts), status, error);
  }
  buildJob(id: string): BuildJob {
    const row = this.db.prepare('SELECT body,file_id,done_parts,status,error FROM build_jobs WHERE id=?').get(id) as { body: string; file_id: string | null; done_parts: string; status: string; error: string | null } | undefined;
    if (!row) throw new Error('Build upload job not found.');
    return { ...JSON.parse(row.body), fileId: row.file_id, doneParts: JSON.parse(row.done_parts), status: row.status, error: row.error } as BuildJob;
  }
  setBuildFile(id: string, fileId: string): void {
    this.db.prepare("UPDATE build_jobs SET file_id=?, done_parts='[]' WHERE id=?").run(fileId, id);
  }
  markBuildPart(id: string, offset: number): void {
    const job = this.buildJob(id);
    if (!job.doneParts.includes(offset)) this.db.prepare('UPDATE build_jobs SET done_parts=? WHERE id=?').run(JSON.stringify([...job.doneParts, offset]), id);
  }
  updateBuild(id: string, status: string, error: string | null = null): void {
    this.db.prepare('UPDATE build_jobs SET status=?,error=? WHERE id=?').run(status, error, id);
  }
  saveCreative(job: CreativeJob): void {
    const { status, error, ...body } = job;
    this.db.prepare('INSERT INTO creative_jobs(id,body,status,error) VALUES (?,?,?,?)').run(job.id, JSON.stringify(body), status, error);
  }
  creative(id: string): CreativeJob {
    const row = this.db.prepare('SELECT body,status,error FROM creative_jobs WHERE id=?').get(id) as { body: string; status: string; error: string | null } | undefined;
    if (!row) throw new Error('Creative asset job not found.');
    return { ...JSON.parse(row.body), status: row.status, error: row.error } as CreativeJob;
  }
  updateCreative(id: string, status: string, error: string | null = null): void {
    this.db.prepare('UPDATE creative_jobs SET status=?,error=? WHERE id=?').run(status, error, id);
  }
  saveWebhookEvent(payload: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO webhook_events(id,received_at,payload) VALUES (?,?,?)').run(id, Date.now(), payload);
    return id;
  }
  webhookEvents(limit = 50): { id: string; receivedAt: number; payload: string }[] {
    const rows = this.db.prepare('SELECT id,received_at,payload FROM webhook_events ORDER BY received_at DESC LIMIT ?').all(limit) as { id: string; received_at: number; payload: string }[];
    return rows.map(r => ({ id: r.id, receivedAt: r.received_at, payload: r.payload }));
  }
  audit(entry: { osUser: string; command: string; account?: string; appId?: string; ok: boolean; error?: string }): void {
    this.db.prepare('INSERT INTO audit_log(id,at,os_user,command,account,app_id,ok,error) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), Date.now(), entry.osUser, entry.command, entry.account ?? null, entry.appId ?? null, entry.ok ? 1 : 0, entry.error ?? null);
  }
  auditLog(limit = 100): Record<string, unknown>[] {
    return this.db.prepare('SELECT at,os_user,command,account,app_id,ok,error FROM audit_log ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  }
  close(): void { this.db.close(); }
}
