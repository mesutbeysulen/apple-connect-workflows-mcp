import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('workflow catalog covers every CLI write command', async () => {
  const source = readFileSync(resolve('src/cli.ts'), 'utf8');
  const match = source.match(/const WRITES: Record<string, Capability> = \{([\s\S]*?)\n\};/);
  assert(match);
  const names = [...match[1]!.matchAll(/(?:'([^']+)'|\b(apply))\s*:/g)].map(m => m[1] ?? m[2]);
  const workflow = readFileSync(resolve('src/workflow-mcp.ts'), 'utf8');
  const groups = [...workflow.matchAll(/(?:upload|review|release|commercial|admin): `([^`]+)`\.split\(' '\)/g)].flatMap(m => m[1]!.split(' '));
  assert.deepEqual([...groups].sort(), [...names].sort());
  const cliOptions = source.match(/const options = \{([\s\S]*?)\} as const/);
  assert(cliOptions);
  const optionNames = [...cliOptions[1]!.matchAll(/(?:'([^']+)'|\b([a-z][a-z0-9]*)):\s*\{ type:/g)].map(m => m[1] ?? m[2]);
  const exposed = [...workflow.matchAll(/const (?:STRING|BOOLEAN)_OPTIONS = new Set\(`([^`]+)`/g)].flatMap(m => m[1]!.split(' '));
  assert.deepEqual(optionNames.filter(name => !exposed.includes(name)).sort(), ['allow-app', 'config', 'execute', 'help', 'individual', 'issuer', 'key-id', 'p8', 'port'].sort());
});

test('MCP workflow uses saved digest, rejects file changes, and never replays an uncertain write', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-workflow-'));
  const config = join(dir, 'config.json');
  const file = join(dir, 'image.png');
  writeFileSync(file, 'first');
  writeFileSync(config, JSON.stringify({ databasePath: join(dir, 'plans.sqlite'), accounts: [{ name: 'demo', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: join(dir, 'missing.p8'), readOnly: false, allowedAppIds: ['123'] }] }));
  const client = new Client({ name: 'workflow-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'serve', '--config', config], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const denied = await client.callTool({ name: 'workflow_prepare', arguments: { command: 'key-setup', args: { account: 'demo' } } });
    assert.equal(denied.isError, true);
    const badFlag = await client.callTool({ name: 'workflow_prepare', arguments: { command: 'asset-upload', args: { account: 'demo', config: '/tmp/other.json' } } });
    assert.equal(badFlag.isError, true);
    const prepared = await client.callTool({ name: 'workflow_prepare', arguments: { command: 'asset-upload', args: { account: 'demo', app: '123', version: 'v', localization: 'l', 'placement-group': 'IPHONE_67', file } } });
    assert.equal(prepared.isError, undefined);
    const plan = (prepared.structuredContent as { result: { id: string; digest: string } }).result;
    const wrong = await client.callTool({ name: 'workflow_apply', arguments: { planId: plan.id, digest: 'a'.repeat(64) } });
    assert.equal(wrong.isError, true);
    writeFileSync(file, 'changed');
    const changed = await client.callTool({ name: 'workflow_apply', arguments: { planId: plan.id, digest: plan.digest } });
    assert.equal(changed.isError, true);
    writeFileSync(file, 'first');
    const failed = await client.callTool({ name: 'workflow_apply', arguments: { planId: plan.id, digest: plan.digest } });
    assert.equal(failed.isError, true); // Missing key: CLI must record the failure.
    const saved = await client.callTool({ name: 'workflow_plan_get', arguments: { planId: plan.id } });
    assert.equal((saved.structuredContent as { result: { status: string } }).result.status, 'uncertain');
    const replay = await client.callTool({ name: 'workflow_apply', arguments: { planId: plan.id, digest: plan.digest } });
    assert.equal(replay.isError, true);
    const next = await client.callTool({ name: 'workflow_prepare', arguments: { command: 'asset-upload', args: { account: 'demo', app: '123', version: 'v', localization: 'l', 'placement-group': 'IPHONE_67', file } } });
    const nextPlan = (next.structuredContent as { result: { id: string; digest: string } }).result;
    const changedConfig = JSON.parse(readFileSync(config, 'utf8'));
    changedConfig.accounts[0].keyId = 'ZZZZZZZZZZ';
    writeFileSync(config, JSON.stringify(changedConfig));
    const identityChanged = await client.callTool({ name: 'workflow_apply', arguments: { planId: nextPlan.id, digest: nextPlan.digest } });
    assert.equal(identityChanged.isError, true);
    const stillPending = await client.callTool({ name: 'workflow_plan_get', arguments: { planId: nextPlan.id } });
    assert.equal((stillPending.structuredContent as { result: { status: string } }).result.status, 'pending');
    const audit = await client.callTool({ name: 'workflow_run', arguments: { command: 'audit', args: {} } });
    assert.match(JSON.stringify(audit.structuredContent), /asset-upload/);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('with mcpApply: false MCP clients cannot apply plans; a person applies them in a terminal', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-workflow-'));
  const config = join(dir, 'config.json');
  const file = join(dir, 'image.png');
  writeFileSync(file, 'first');
  writeFileSync(config, JSON.stringify({ databasePath: join(dir, 'plans.sqlite'), accounts: [{ name: 'demo', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: join(dir, 'missing.p8'), readOnly: false, allowedAppIds: ['123'], mcpApply: false }] }));
  const client = new Client({ name: 'workflow-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'serve', '--config', config], stderr: 'pipe' });
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args, '--config', config], { encoding: 'utf8' });
  try {
    await client.connect(transport);
    const prepared = await client.callTool({ name: 'workflow_prepare', arguments: { command: 'asset-upload', args: { account: 'demo', app: '123', version: 'v', localization: 'l', 'placement-group': 'IPHONE_67', file } } });
    const plan = (prepared.structuredContent as { result: { id: string; digest: string; mcpApply: boolean; applyInTerminal: string } }).result;
    assert.equal(plan.mcpApply, false);
    assert.equal(plan.applyInTerminal, `apple-connect-mcp workflow-apply --plan ${plan.id} --digest ${plan.digest} --config ${JSON.stringify(config)}`);
    const refused = await client.callTool({ name: 'workflow_apply', arguments: { planId: plan.id, digest: plan.digest } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /workflow-apply --plan/);
    const pending = await client.callTool({ name: 'workflow_plan_get', arguments: { planId: plan.id } });
    assert.equal((pending.structuredContent as { result: { status: string } }).result.status, 'pending');
    // From the terminal: a wrong digest is refused and leaves the plan pending; the right one runs it once.
    assert.match(cli('workflow-apply', '--plan', plan.id, '--digest', 'b'.repeat(64)).stderr, /digest mismatch/);
    const ran = cli('workflow-apply', '--plan', plan.id, '--digest', plan.digest);
    assert.notEqual(ran.status, 0); // Missing key: the run reaches the CLI and is recorded.
    const after = await client.callTool({ name: 'workflow_plan_get', arguments: { planId: plan.id } });
    assert.equal((after.structuredContent as { result: { status: string } }).result.status, 'uncertain');
    assert.match(cli('workflow-apply', '--plan', plan.id, '--digest', plan.digest).stderr, /status is uncertain/);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
