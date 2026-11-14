import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('server.json matches package.json, so the MCP Registry accepts each release', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const server = JSON.parse(readFileSync(resolve('server.json'), 'utf8'));
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.mesutbeysulen\/[a-zA-Z0-9._-]+$/);
  assert(server.description.length <= 100, 'The registry caps description at 100 characters.');
  assert.equal(server.version, pkg.version, 'Bump server.json with package.json.');
  assert.equal(server.packages.length, 1);
  assert.deepEqual([server.packages[0].registryType, server.packages[0].identifier, server.packages[0].version, server.packages[0].transport.type], ['npm', pkg.name, pkg.version, 'stdio']);
  assert.deepEqual(server.packages[0].environmentVariables.map((v: { name: string }) => v.name), ['APPLE_CONNECT_CONFIG']);
});
