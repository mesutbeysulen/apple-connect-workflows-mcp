import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { requireWrite, type Account } from './config.js';
import type { Resource } from './apple.js';
import { EDITABLE_VERSION_STATES, validGroup, validId, versionOfApp } from './apple-rules.js';
import type { PlanStore } from './plans.js';
import { orderPlacements, uploadAsset, type AssetAPI } from './asset-library.js';
import { readImage } from './screenshots.js';
import { checkAppInfoFields, checkLocale, checkVersionLocaleFields, setAppInfo, setVersionLocale, type PrepAPI } from './release-prep.js';

export const localeTextSchema = z.object({
  name: z.string().optional(), subtitle: z.string().optional(), privacyPolicyUrl: z.string().optional(), privacyChoicesUrl: z.string().optional(), privacyPolicyText: z.string().optional(),
  description: z.string().optional(), keywords: z.string().optional(), whatsNew: z.string().optional(), promotionalText: z.string().optional(), supportUrl: z.string().optional(), marketingUrl: z.string().optional(),
}).strict();
export const metadataFileSchema = z.object({ locales: z.record(z.string(), localeTextSchema) }).strict();
export type MetadataFile = z.infer<typeof metadataFileSchema>;
const INFO_FIELDS = ['name', 'subtitle', 'privacyPolicyUrl', 'privacyChoicesUrl', 'privacyPolicyText'] as const;
const VERSION_FIELDS = ['description', 'keywords', 'whatsNew', 'promotionalText', 'supportUrl', 'marketingUrl'] as const;
export interface MetadataChange { locale: string; target: 'appInfo' | 'version'; action: 'create' | 'update'; fields: Record<string, { from: unknown; to: unknown }> }
const pick = <K extends string>(source: Record<string, unknown>, keys: readonly K[]) => Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]])) as Partial<Record<K, string>>;

export async function readMetadataFile(path: string): Promise<MetadataFile> {
  if (!isAbsolute(path)) throw new Error('Use an absolute metadata file path.');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Metadata file is missing or not valid JSON.'); }
  return metadataFileSchema.parse(raw);
}
/** Compares one file of all-language text with Apple, then optionally applies only the differences. Safe to rerun. */
export async function syncMetadata(input: { account: Account; appId: string; versionId: string; metadata: MetadataFile; execute?: boolean }, api: Pick<PrepAPI, 'get' | 'list'> & Partial<PrepAPI>) {
  const { account, appId, versionId, metadata, execute = false } = input;
  if (execute) requireWrite(account, appId);
  if (![appId, versionId].every(validId)) throw new Error('Invalid app or version ID.');
  await versionOfApp(api, appId, versionId);
  const locales = Object.entries(metadata.locales);
  if (!locales.length) throw new Error('Metadata file lists no locales.');
  const versionRows = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  const infos = await api.list(`/v1/apps/${appId}/appInfos?limit=50`, 50);
  const info = infos.data.find(row => EDITABLE_VERSION_STATES.includes(String(row.attributes.state ?? row.attributes.appStoreState)));
  const infoRows = info ? await api.list(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`, 2000) : { data: [], truncated: false };
  if (versionRows.truncated || infoRows.truncated) throw new Error('Incomplete locale list; refusing to compare.');
  const changes: MetadataChange[] = [];
  const diff = (locale: string, target: MetadataChange['target'], fields: Record<string, unknown>, rows: Resource[]) => {
    if (!Object.keys(fields).length) return;
    const existing = rows.find(row => row.attributes.locale === locale);
    const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => existing?.attributes[key] !== value).map(([key, value]) => [key, { from: existing?.attributes[key] ?? null, to: value }]));
    if (Object.keys(changed).length) changes.push({ locale, target, action: existing ? 'update' : 'create', fields: changed });
  };
  // Everything is validated first, so a mistake in the last language cannot leave the first ones half applied.
  for (const [locale, text] of locales) {
    checkLocale(locale);
    const infoFields = pick(text, INFO_FIELDS); const versionFields = pick(text, VERSION_FIELDS);
    checkAppInfoFields(infoFields); checkVersionLocaleFields(versionFields);
    if (Object.keys(infoFields).length) {
      if (!info) throw new Error('This app has no editable app information, so name and privacy fields cannot change. Create a new version first.');
      if (!infoRows.data.some(row => row.attributes.locale === locale) && !infoFields.name) throw new Error(`${locale}: name is required to add this language to app information.`);
    }
    diff(locale, 'appInfo', infoFields, infoRows.data);
    diff(locale, 'version', versionFields, versionRows.data);
  }
  if (!execute) return { dryRun: true, changes, applied: [] as string[] };
  const applied: string[] = [];
  for (const change of changes) {
    const text = metadata.locales[change.locale]!;
    try {
      if (change.target === 'appInfo') await setAppInfo({ account, appId, locale: change.locale, ...pick(text, INFO_FIELDS) }, api as PrepAPI);
      else await setVersionLocale({ account, appId, versionId, locale: change.locale, ...pick(text, VERSION_FIELDS) }, api as PrepAPI);
      applied.push(`${change.locale}:${change.target}`);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'Update failed'} Applied before this failure: ${applied.join(', ') || 'nothing'}. Rerun to continue.`);
    }
  }
  return { dryRun: false, changes, applied };
}

export interface ShotFile { locale: string; group: string; filePath: string; sha256: string }
/** Reads <dir>/<locale>/<placementGroup>/<files>, in file name order. */
export async function scanScreenshots(dir: string): Promise<ShotFile[]> {
  if (!isAbsolute(dir)) throw new Error('Use an absolute screenshots folder.');
  const folders = async (path: string) => (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
  const shots: ShotFile[] = [];
  for (const locale of await folders(dir)) {
    checkLocale(locale);
    for (const group of await folders(join(dir, locale))) {
      if (!validGroup(group)) throw new Error(`Invalid placement group folder ${group}.`);
      const names = (await readdir(join(dir, locale, group), { withFileTypes: true })).filter(e => e.isFile() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      for (const name of names) {
        const filePath = join(dir, locale, group, name);
        shots.push({ locale, group, filePath, sha256: (await readImage(filePath)).sha256 });
      }
    }
  }
  if (!shots.length) throw new Error('No screenshots found. Expected <folder>/<locale>/<placementGroup>/<image files>.');
  return shots;
}
/**
 * Makes each locale and group match a folder: uploads new files, keeps ones this tool already placed, and sets
 * the order from file names. Screenshots not from this folder are removed only with replace. Previews unless execute.
 */
export async function syncScreenshots(input: { account: Account; appId: string; versionId: string; dir: string; replace?: boolean; execute?: boolean }, api: AssetAPI, store: PlanStore, fetcher: typeof fetch = fetch) {
  const { account, appId, versionId, dir, replace = false, execute = false } = input;
  if (execute) requireWrite(account, appId);
  const shots = await scanScreenshots(dir);
  const localizations = await api.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`, 2000);
  if (localizations.truncated) throw new Error('Incomplete localization list.');
  const plan = [];
  for (const key of [...new Set(shots.map(s => `${s.locale}/${s.group}`))]) {
    const [locale, group] = key.split('/') as [string, string];
    const localization = localizations.data.find(row => row.attributes.locale === locale);
    if (!localization) throw new Error(`Version has no ${locale} language. Add it with version-localize or metadata-sync first.`);
    const query = new URLSearchParams({ 'filter[placementType]': 'APP_SCREENSHOT', 'filter[placementGroup]': group, sort: 'placementGroupPosition', limit: '200' });
    const existing = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/placements?${query}`, 200);
    if (existing.truncated) throw new Error(`Incomplete placement list for ${key}.`);
    const placedByHash = new Map(store.assetJobsFor(localization.id, group).filter(j => j.placementId && existing.data.some(p => p.id === j.placementId)).map(j => [j.sha256, j.placementId!]));
    const files = shots.filter(s => s.locale === locale && s.group === group);
    const keep = files.flatMap(f => placedByHash.has(f.sha256) ? [placedByHash.get(f.sha256)!] : []);
    plan.push({ locale, group, localizationId: localization.id, files, placedByHash, upload: files.filter(f => !placedByHash.has(f.sha256)).map(f => f.filePath), keep, remove: existing.data.map(p => p.id).filter(id => !keep.includes(id)) });
  }
  const summary = plan.map(({ locale, group, upload, keep, remove }) => ({ locale, group, upload, keep: keep.length, remove }));
  const blocked = plan.filter(p => p.remove.length && !replace);
  const note = blocked.length ? `Existing screenshots not from this folder block ${blocked.map(p => `${p.locale}/${p.group}`).join(', ')}. Pass --replace to remove them.` : undefined;
  if (!execute) return { dryRun: true, groups: summary, ...(note ? { note } : {}) };
  if (note) throw new Error(note);
  for (const step of plan) {
    const order: string[] = [];
    for (const file of step.files) {
      const placed = step.placedByHash.get(file.sha256);
      if (placed) { order.push(placed); continue; }
      order.push((await uploadAsset({ account, appId, versionId, localizationId: step.localizationId, placementGroup: step.group, filePath: file.filePath }, api, fetcher, store)).placementId);
    }
    // Keep the old page intact until every replacement is safely uploaded and placed.
    for (const id of step.remove) await api.delete(`/v1/appAssetLibraryPlacements/${id}`);
    if (order.length > 1) await orderPlacements({ account, appId, versionId, localizationId: step.localizationId, placementGroup: step.group, placementIds: order }, api);
  }
  return { dryRun: false, groups: summary };
}
