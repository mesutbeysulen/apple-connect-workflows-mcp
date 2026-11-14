import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requireWrite, type Account } from './config.js';
import { AppleError, type Resource } from './apple.js';
import { validId } from './apple-rules.js';

export interface CloudAPI {
  get(path: string): Promise<Resource>;
  list(path: string, limit?: number): Promise<{ data: Resource[]; truncated: boolean }>;
  post(path: string, body: unknown): Promise<Resource>;
  patch(path: string, type: string, id: string, attributes: Record<string, unknown>): Promise<unknown>;
}
const rel = (type: string, id: string) => ({ data: { type, id } });
const needIds = (...ids: string[]) => { if (!ids.every(validId)) throw new Error('Invalid ID.'); };
async function all(api: Pick<CloudAPI, 'list'>, path: string): Promise<Resource[]> {
  const rows = await api.list(path, 2000);
  if (rows.truncated) throw new Error(`Incomplete list at ${path.split('?')[0]}; refusing to continue.`);
  return rows.data;
}
/** The app's Xcode Cloud product; every workflow and build run hangs off it. */
export async function cloudProduct(api: Pick<CloudAPI, 'get'>, appId: string): Promise<Resource> {
  if (!/^\d+$/.test(appId)) throw new Error('Invalid app ID.');
  try {
    const product = await api.get(`/v1/apps/${appId}/ciProduct`);
    if (product?.id) return product;
  } catch (error) { if (!(error instanceof AppleError && error.status === 404)) throw error; }
  throw new Error('Xcode Cloud is not set up for this app. Set it up once in Xcode, then use these commands.');
}
async function ownedWorkflow(api: CloudAPI, appId: string, workflowId: string): Promise<Resource> {
  needIds(workflowId);
  const product = await cloudProduct(api, appId);
  const workflow = (await all(api, `/v1/ciProducts/${product.id}/workflows?limit=200`)).find(row => row.id === workflowId);
  if (!workflow) throw new Error('Workflow does not belong to this app\'s Xcode Cloud product.');
  return workflow;
}
/** Build runs are checked against the product's most recent 200, which covers any run worth acting on. */
async function ownedBuildRun(api: CloudAPI, appId: string, buildRunId: string): Promise<Resource> {
  needIds(buildRunId);
  const product = await cloudProduct(api, appId);
  const rows = (await api.list(`/v1/ciProducts/${product.id}/buildRuns?sort=-number&limit=200`, 200)).data;
  if (!rows.some(row => row.id === buildRunId)) throw new Error('Build run is not among this app\'s recent Xcode Cloud builds.');
  return api.get(`/v1/ciBuildRuns/${buildRunId}`);
}

export interface StartInput { account: Account; appId: string; workflowId: string; branch?: string; tag?: string; pullRequest?: number; rebuildOf?: string; clean?: boolean; execute?: boolean }
/**
 * Starts a build of a workflow on a branch, tag or pull request, or reruns an earlier build. Each run uses
 * Xcode Cloud compute time, so it previews the resolved source unless execute is set.
 */
export async function startBuild(input: StartInput, api: CloudAPI) {
  const { account, appId, workflowId, branch, tag, pullRequest, rebuildOf, clean, execute = false } = input;
  if (execute) requireWrite(account, appId);
  const sources = [branch, tag, pullRequest, rebuildOf].filter(v => v !== undefined);
  if (sources.length > 1) throw new Error('Choose one of --branch, --tag, --pull-request or --rebuild.');
  const workflow = await ownedWorkflow(api, appId, workflowId);
  const relationships: Record<string, unknown> = { workflow: rel('ciWorkflows', workflowId) };
  let source: Record<string, unknown> = { kind: 'workflow default' };
  if (rebuildOf !== undefined) {
    await ownedBuildRun(api, appId, rebuildOf);
    relationships.buildRun = rel('ciBuildRuns', rebuildOf);
    source = { kind: 'rebuild', buildRunId: rebuildOf };
  } else if (branch !== undefined || tag !== undefined || pullRequest !== undefined) {
    const repository = await api.get(`/v1/ciWorkflows/${workflowId}/repository`);
    if (pullRequest !== undefined) {
      if (!Number.isInteger(pullRequest) || pullRequest < 1) throw new Error('--pull-request must be a pull request number.');
      const found = (await all(api, `/v1/scmRepositories/${repository.id}/pullRequests?limit=200`)).find(row => Number(row.attributes.number) === pullRequest);
      if (!found) throw new Error(`Pull request #${pullRequest} was not found in ${repository.attributes.repositoryName ?? 'the workflow repository'}.`);
      if (found.attributes.isClosed === true) throw new Error(`Pull request #${pullRequest} is closed.`);
      relationships.pullRequest = rel('scmPullRequests', found.id);
      source = { kind: 'pull request', number: pullRequest, title: found.attributes.title };
    } else {
      const name = (branch ?? tag)!;
      const kind = branch !== undefined ? 'BRANCH' : 'TAG';
      const found = (await all(api, `/v1/scmRepositories/${repository.id}/gitReferences?limit=200`))
        .find(row => row.attributes.kind === kind && row.attributes.isDeleted !== true && (row.attributes.name === name || row.attributes.canonicalName === name));
      if (!found) throw new Error(`${kind === 'BRANCH' ? 'Branch' : 'Tag'} ${name} was not found in the workflow repository.`);
      relationships.sourceBranchOrTag = rel('scmGitReferences', found.id);
      source = { kind: kind.toLowerCase(), name: found.attributes.canonicalName ?? name };
    }
  }
  const preview = { dryRun: !execute, workflowId, workflow: workflow.attributes.name, enabled: workflow.attributes.isEnabled, source, clean: clean ?? false,
    effect: 'Starts a new Xcode Cloud build, which uses compute time.' };
  if (workflow.attributes.isEnabled === false) throw new Error('This workflow is disabled. Enable it with ci-workflow-enable first.');
  if (!execute) return preview;
  const created = await api.post('/v1/ciBuildRuns', { data: { type: 'ciBuildRuns', ...(clean === undefined ? {} : { attributes: { clean } }), relationships } });
  return { ...preview, status: 'started' as const, buildRunId: created.id, number: created.attributes?.number };
}

export interface RunSummary {
  buildRunId: string; number: unknown; progress: string; result: string | null; done: boolean; ok: boolean; source: unknown;
  actions: { id: string; name: unknown; type: unknown; progress: unknown; result: unknown; required: unknown; issueCounts: unknown }[];
  problems: { action: unknown; type: unknown; message: unknown; file: unknown }[];
  failedTests: { action: unknown; test: string; message: unknown }[];
}
const FAILED = new Set(['FAILED', 'ERRORED']);
/** Reads a build run with every action; for failed actions also the issues and failing tests, so the cause is visible. */
export async function buildRunSummary(api: Pick<CloudAPI, 'get' | 'list'>, buildRunId: string, run?: Resource): Promise<RunSummary> {
  needIds(buildRunId);
  run ??= await api.get(`/v1/ciBuildRuns/${buildRunId}`);
  const progress = String(run.attributes.executionProgress ?? 'UNKNOWN');
  const result = run.attributes.completionStatus === undefined || run.attributes.completionStatus === null ? null : String(run.attributes.completionStatus);
  const actions = await all(api, `/v1/ciBuildRuns/${buildRunId}/actions?limit=200`);
  const problems: RunSummary['problems'] = [];
  const failedTests: RunSummary['failedTests'] = [];
  for (const action of actions.filter(a => FAILED.has(String(a.attributes.completionStatus)))) {
    for (const issue of (await api.list(`/v1/ciBuildActions/${action.id}/issues?limit=200`, 200)).data.slice(0, 50)) {
      problems.push({ action: action.attributes.name, type: issue.attributes.issueType, message: issue.attributes.message, file: issue.attributes.fileSource });
    }
    for (const testResult of (await api.list(`/v1/ciBuildActions/${action.id}/testResults?limit=200`, 2000)).data) {
      if (testResult.attributes.status === 'FAILURE') {
        failedTests.push({ action: action.attributes.name, test: `${testResult.attributes.className ?? ''}.${testResult.attributes.name ?? ''}`, message: testResult.attributes.message });
      }
    }
  }
  return {
    buildRunId, number: run.attributes.number, progress, result, done: progress === 'COMPLETE', ok: result === 'SUCCEEDED',
    source: { commit: (run.attributes.sourceCommit as { commitSha?: string } | undefined)?.commitSha ?? null, startReason: run.attributes.startReason ?? null, isPullRequestBuild: run.attributes.isPullRequestBuild ?? null },
    actions: actions.map(a => ({ id: a.id, name: a.attributes.name, type: a.attributes.actionType, progress: a.attributes.executionProgress, result: a.attributes.completionStatus, required: a.attributes.isRequiredToPass, issueCounts: a.attributes.issueCounts })),
    problems, failedTests: failedTests.slice(0, 100),
  };
}
export async function reportBuildRun(input: { appId: string; buildRunId: string }, api: CloudAPI): Promise<RunSummary> {
  return buildRunSummary(api, input.buildRunId, await ownedBuildRun(api, input.appId, input.buildRunId));
}
/** Polls a build run until it completes. Transient errors are retried; client errors and the deadline end the wait. */
export async function waitForBuildRun(input: { appId: string; buildRunId: string }, api: CloudAPI, options: {
  timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onProgress?: (line: string) => void;
} = {}): Promise<RunSummary> {
  const { timeoutMs = 90 * 60_000, intervalMs = 30_000, now = Date.now } = options;
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  if (!(intervalMs >= 1000) || !(timeoutMs >= intervalMs)) throw new Error('Interval must be at least 1s and not exceed the timeout.');
  await ownedBuildRun(api, input.appId, input.buildRunId);
  const deadline = now() + timeoutMs;
  let last = '';
  for (;;) {
    let run: Resource;
    try { run = await api.get(`/v1/ciBuildRuns/${input.buildRunId}`); }
    catch (error) {
      const final = error instanceof AppleError && error.status >= 400 && error.status < 500 && error.status !== 429;
      if (final || now() + intervalMs > deadline) throw error;
      await sleep(intervalMs);
      continue;
    }
    const line = `${run.attributes.executionProgress ?? 'UNKNOWN'}/${run.attributes.completionStatus ?? '-'}`;
    if (line !== last) { options.onProgress?.(line); last = line; }
    if (run.attributes.executionProgress === 'COMPLETE') return buildRunSummary(api, input.buildRunId, run);
    if (now() + intervalMs > deadline) throw new Error(`Timed out waiting for build run ${input.buildRunId}; last state ${line}. Run ci-build-wait again later.`);
    await sleep(intervalMs);
  }
}
/** Lists the files a build run produced, such as archives, logs and test products. */
export async function listArtifacts(input: { appId: string; buildRunId: string }, api: CloudAPI) {
  await ownedBuildRun(api, input.appId, input.buildRunId);
  const out = [];
  for (const action of await all(api, `/v1/ciBuildRuns/${input.buildRunId}/actions?limit=200`)) {
    for (const artifact of await all(api, `/v1/ciBuildActions/${action.id}/artifacts?limit=200`)) {
      out.push({ artifactId: artifact.id, action: action.attributes.name, fileName: artifact.attributes.fileName, fileType: artifact.attributes.fileType, fileSize: artifact.attributes.fileSize });
    }
  }
  return { buildRunId: input.buildRunId, artifacts: out };
}
/** Streams an artifact from its signed download URL to a private file. API credentials are not sent. */
export async function downloadArtifact(input: { appId: string; buildRunId: string; artifactId: string; out: string }, api: CloudAPI, fetcher: typeof fetch = fetch) {
  const { appId, buildRunId, artifactId, out } = input;
  needIds(artifactId);
  if (!isAbsolute(out)) throw new Error('--out must be an absolute path.');
  const { artifacts } = await listArtifacts({ appId, buildRunId }, api);
  if (!artifacts.some(a => a.artifactId === artifactId)) throw new Error('Artifact does not belong to this build run.');
  const artifact = await api.get(`/v1/ciArtifacts/${artifactId}`);
  const url = new URL(String(artifact.attributes.downloadUrl ?? ''));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe artifact download URL.');
  const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Artifact download failed: HTTP ${response.status}.`);
  const temporary = join(dirname(out), `.${randomUUID()}.tmp`);
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
    await rename(temporary, out);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { artifactId, fileName: artifact.attributes.fileName, out };
}
/** Turns a workflow's automatic starts on or off. Creating workflows stays in Xcode or a reviewed api_write_plan. */
export async function setWorkflowEnabled(input: { account: Account; appId: string; workflowId: string; enabled: boolean }, api: CloudAPI) {
  const { account, appId, workflowId, enabled } = input;
  requireWrite(account, appId);
  const workflow = await ownedWorkflow(api, appId, workflowId);
  if (workflow.attributes.isEnabled === enabled) return { workflowId, enabled, status: 'unchanged' as const };
  await api.patch(`/v1/ciWorkflows/${workflowId}`, 'ciWorkflows', workflowId, { isEnabled: enabled });
  return { workflowId, enabled, status: 'updated' as const };
}
