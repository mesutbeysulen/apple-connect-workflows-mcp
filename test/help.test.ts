import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOPICS, topicCommands, findTopic, overview, allHelp } from '../src/help.js';
import { commandsMarkdown } from '../src/docs.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const handled = [...cli.matchAll(/^  '?([a-z][a-z0-9-]*)'?: async \(/gm)].map(m => m[1]!);
const special = ['serve', 'doctor', 'key-setup', 'webhook-listen'];

test('every CLI command is documented in exactly one help topic', () => {
  const listed = TOPICS.flatMap(topicCommands);
  const counts = new Map<string, number>();
  for (const name of listed) counts.set(name, (counts.get(name) ?? 0) + 1);
  const missing = [...handled, ...special].filter(name => !counts.has(name));
  const twice = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  const stale = listed.filter(name => ![...handled, ...special].includes(name));
  assert.deepEqual({ missing, twice, stale }, { missing: [], twice: [], stale: [] });
});
test('help finds topics by name or by command', () => {
  assert.equal(findTopic('game-center')?.id, 'game-center');
  assert.equal(findTopic('gc-create')?.id, 'game-center');
  assert.equal(findTopic('build-upload')?.id, 'builds');
  assert.equal(findTopic('nothing'), undefined);
  assert.match(overview(), /game-center\s+Leaderboards/);
  for (const topic of TOPICS) assert(allHelp().includes(topic.commands.trim().split('\n')[0]!), topic.id);
});
test('docs/commands.md matches the help source', () => {
  const file = readFileSync(new URL('../docs/commands.md', import.meta.url), 'utf8');
  assert.equal(file, commandsMarkdown(), 'docs/commands.md is out of date; run npm run build && npm run docs');
});
