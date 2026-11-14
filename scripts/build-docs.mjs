#!/usr/bin/env node
// Regenerates docs/commands.md and docs/mcp-tools.md from the built CLI help and a live MCP tool listing.
//   npm run build && npm run docs
// test/help.test.ts fails when these files are out of date.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { commandsMarkdown, toolsMarkdown } from '../dist/docs.js';

const root = new URL('../', import.meta.url);
writeFileSync(new URL('docs/commands.md', root), commandsMarkdown());

const dir = mkdtempSync(join(tmpdir(), 'apple-docs-'));
const config = join(dir, 'config.json');
writeFileSync(config, JSON.stringify({ databasePath: join(dir, 'db.sqlite'), accounts: [{ name: 'docs', issuerId: '11111111-1111-4111-8111-111111111111', keyId: 'ABCDEFGHIJ', privateKeyPath: join(dir, 'none.p8') }] }));
const client = new Client({ name: 'docs', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('dist/cli.js', root).pathname, 'serve', '--config', config] }));
  const { tools } = await client.listTools();
  writeFileSync(new URL('docs/mcp-tools.md', root), toolsMarkdown(tools));
  console.log(`docs/commands.md and docs/mcp-tools.md written (${tools.length} tools).`);
} finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
