import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ci from '../src/xcode-cloud.js';
import { AppleError } from '../src/apple.js';
import { account, readOnly, res, fakeApi } from './helpers.js';

const cloud = (extra: Record<string, unknown> = {}) => fakeApi({
  '/v1/apps/123/ciProduct': res('prod', 'ciProducts'),
  '/v1/ciProducts/prod/workflows': [res('wf', 'ciWorkflows', { name: 'Release', isEnabled: true }), res('off', 'ciWorkflows', { name: 'Nightly', isEnabled: false })],
  '/v1/ciProducts/prod/buildRuns': [res('run1', 'ciBuildRuns', { number: 41 }), res('run2', 'ciBuildRuns', { number: 42 })],
  '/v1/ciWorkflows/wf/repository': res('repo', 'scmRepositories', { repositoryName: 'game' }),
  '/v1/scmRepositories/repo/gitReferences': [res('ref-main', 'scmGitReferences', { kind: 'BRANCH', name: 'main', canonicalName: 'refs/heads/main' }), res('ref-tag', 'scmGitReferences', { kind: 'TAG', name: 'v1.0', canonicalName: 'refs/tags/v1.0' }), res('ref-gone', 'x', { kind: 'BRANCH', name: 'old', isDeleted: true })],
  '/v1/scmRepositories/repo/pullRequests': [res('pr7', 'scmPullRequests', { number: 7, title: 'Fix crash' }), res('pr8', 'x', { number: 8, isClosed: true })],
  '/v1/ciBuildRuns/run1': res('run1', 'ciBuildRuns', { number: 41, executionProgress: 'COMPLETE', completionStatus: 'FAILED', sourceCommit: { commitSha: 'abc' } }),
  '/v1/ciBuildRuns/run1/actions': [res('build', 'ciBuildActions', { name: 'Archive', completionStatus: 'SUCCEEDED' }), res('tests', 'ciBuildActions', { name: 'Test', completionStatus: 'FAILED' })],
  '/v1/ciBuildActions/tests/issues': [res('i1', 'ciIssues', { issueType: 'TEST_FAILURE', message: 'expected 1 got 2', fileSource: { path: 'GameTests.swift', lineNumber: 12 } })],
  '/v1/ciBuildActions/tests/testResults': [res('t1', 'ciTestResults', { className: 'GameTests', name: 'testScore()', status: 'FAILURE', message: 'expected 1 got 2' }), res('t2', 'x', { className: 'GameTests', name: 'testOk()', status: 'SUCCESS' })],
  '/v1/ciBuildActions/build/artifacts': [res('art', 'ciArtifacts', { fileName: 'Game.xcarchive.zip', fileType: 'ARCHIVE', fileSize: 5 })],
  '/v1/ciBuildActions/tests/artifacts': [],
  '/v1/ciArtifacts/art': res('art', 'ciArtifacts', { fileName: 'Game.xcarchive.zip', downloadUrl: 'https://artifacts.example.apple.com/a?sig=1' }),
  ...extra,
} as never, { post: (path, body) => res('new-run', body.data.type, { number: 43 }) });
const base = { account, appId: '123', workflowId: 'wf' };

test('starting a build previews the resolved source and needs execute', async () => {
  const f = cloud();
  const preview = await ci.startBuild({ ...base, account: readOnly, branch: 'main' }, f.api);
  assert.deepEqual(preview.source, { kind: 'branch', name: 'refs/heads/main' });
  assert.equal(f.writes().length, 0);
  const started = await ci.startBuild({ ...base, branch: 'main', clean: true, execute: true }, f.api);
  assert.equal((started as { buildRunId?: string }).buildRunId, 'new-run');
  const body = f.writes()[0]!.body as any;
  assert.equal(body.data.relationships.sourceBranchOrTag.data.id, 'ref-main');
  assert.equal(body.data.attributes.clean, true);
  await ci.startBuild({ ...base, tag: 'v1.0', execute: true }, f.api);
  assert.equal((f.writes()[1]!.body as any).data.relationships.sourceBranchOrTag.data.id, 'ref-tag');
  await ci.startBuild({ ...base, pullRequest: 7, execute: true }, f.api);
  assert.equal((f.writes()[2]!.body as any).data.relationships.pullRequest.data.id, 'pr7');
  await ci.startBuild({ ...base, rebuildOf: 'run1', execute: true }, f.api);
  assert.equal((f.writes()[3]!.body as any).data.relationships.buildRun.data.id, 'run1');
  await ci.startBuild({ ...base, execute: true }, f.api);
  assert.deepEqual(Object.keys((f.writes()[4]!.body as any).data.relationships), ['workflow']);
});
test('build start refuses unknown, deleted or closed sources and disabled workflows', async () => {
  const f = cloud();
  await assert.rejects(ci.startBuild({ ...base, branch: 'nope' }, f.api), /Branch nope was not found/);
  await assert.rejects(ci.startBuild({ ...base, branch: 'old' }, f.api), /not found/);
  await assert.rejects(ci.startBuild({ ...base, pullRequest: 8 }, f.api), /closed/);
  await assert.rejects(ci.startBuild({ ...base, pullRequest: 99 }, f.api), /#99 was not found/);
  await assert.rejects(ci.startBuild({ ...base, branch: 'main', tag: 'v1.0' }, f.api), /Choose one/);
  await assert.rejects(ci.startBuild({ ...base, workflowId: 'off' }, f.api), /disabled/);
  await assert.rejects(ci.startBuild({ ...base, workflowId: 'stranger' }, f.api), /does not belong/);
  await assert.rejects(ci.startBuild({ ...base, rebuildOf: 'old-run' }, f.api), /not among/);
  await assert.rejects(ci.startBuild({ ...base, execute: true, account: readOnly }, f.api), /read-only/);
  await assert.rejects(ci.startBuild(base, cloud({ '/v1/apps/123/ciProduct': undefined }).api), /set it up once in Xcode/i);
  assert.equal(f.writes().length, 0);
});
test('a finished run reports failed actions with issues and failing tests only', async () => {
  const report = await ci.reportBuildRun({ appId: '123', buildRunId: 'run1' }, cloud().api);
  assert.deepEqual([report.done, report.ok, report.result], [true, false, 'FAILED']);
  assert.deepEqual(report.actions.map(a => [a.name, a.result]), [['Archive', 'SUCCEEDED'], ['Test', 'FAILED']]);
  assert.deepEqual(report.problems, [{ action: 'Test', type: 'TEST_FAILURE', message: 'expected 1 got 2', file: { path: 'GameTests.swift', lineNumber: 12 } }]);
  assert.deepEqual(report.failedTests.map(t => t.test), ['GameTests.testScore()']);
  assert.deepEqual(report.source, { commit: 'abc', startReason: null, isPullRequestBuild: null });
});
test('waiting follows progress, survives a network blip and stops at the deadline', async () => {
  // The first read is the ownership check, before polling starts.
  const steps = ['PENDING', 'PENDING', 'blip', 'RUNNING', 'COMPLETE'];
  let call = 0; let clock = 0; const seen: string[] = [];
  const f = cloud();
  const api = { ...f.api, get: async (path: string) => {
    if (path !== '/v1/ciBuildRuns/run2') return f.api.get(path);
    const state = steps[Math.min(call++, steps.length - 1)]!;
    if (state === 'blip') throw new TypeError('fetch failed');
    return res('run2', 'ciBuildRuns', { executionProgress: state, completionStatus: state === 'COMPLETE' ? 'SUCCEEDED' : null });
  }, list: async (path: string) => path.startsWith('/v1/ciBuildRuns/run2/actions') ? { data: [], truncated: false } : f.api.list(path) };
  const result = await ci.waitForBuildRun({ appId: '123', buildRunId: 'run2' }, api, { intervalMs: 1000, sleep: async () => { clock += 1000; }, now: () => clock, onProgress: l => seen.push(l) });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['PENDING/-', 'RUNNING/-', 'COMPLETE/SUCCEEDED']);
  const stuck = { ...f.api, get: async (path: string) => path === '/v1/ciBuildRuns/run2' ? res('run2', 'x', { executionProgress: 'RUNNING' }) : f.api.get(path) };
  let t = 0;
  await assert.rejects(ci.waitForBuildRun({ appId: '123', buildRunId: 'run2' }, stuck, { intervalMs: 1000, timeoutMs: 3000, sleep: async () => { t += 1000; }, now: () => t }), /Timed out.*RUNNING/);
  const denied = { ...f.api, get: async (path: string) => { if (path === '/v1/ciBuildRuns/run2') throw new AppleError(403, []); return f.api.get(path); } };
  await assert.rejects(ci.waitForBuildRun({ appId: '123', buildRunId: 'run2' }, denied, { intervalMs: 1000, sleep: async () => {} }), /403/);
});
test('artifacts are listed per action and downloaded privately without credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-')); const out = join(dir, 'Game.xcarchive.zip');
  const f = cloud();
  const fetcher = (async (url: URL, init: RequestInit) => {
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(url.hostname, 'artifacts.example.apple.com');
    return new Response('bytes');
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual((await ci.listArtifacts({ appId: '123', buildRunId: 'run1' }, f.api)).artifacts.map(a => [a.artifactId, a.action]), [['art', 'Archive']]);
    await ci.downloadArtifact({ appId: '123', buildRunId: 'run1', artifactId: 'art', out }, f.api, fetcher);
    assert.equal(readFileSync(out, 'utf8'), 'bytes');
    assert.equal(statSync(out).mode & 0o777, 0o600);
    await assert.rejects(ci.downloadArtifact({ appId: '123', buildRunId: 'run1', artifactId: 'other', out: join(dir, 'x') }, f.api, fetcher), /does not belong/);
    const unsafe = cloud({ '/v1/ciArtifacts/art': res('art', 'x', { downloadUrl: 'http://plain.example/a' }) });
    await assert.rejects(ci.downloadArtifact({ appId: '123', buildRunId: 'run1', artifactId: 'art', out: join(dir, 'y') }, unsafe.api, fetcher), /Unsafe/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('workflows can be switched on and off', async () => {
  const f = cloud();
  assert.equal((await ci.setWorkflowEnabled({ ...base, enabled: true }, f.api)).status, 'unchanged');
  assert.equal((await ci.setWorkflowEnabled({ ...base, workflowId: 'off', enabled: true }, f.api)).status, 'updated');
  assert.deepEqual(f.writes()[0]!.body, { isEnabled: true });
});
