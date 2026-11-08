#!/usr/bin/env node
// Regenerates catalog/endpoints.json from Apple's OpenAPI document:
//   node scripts/build-catalog.mjs /absolute/path/to/openapi.oas.json
import { readFileSync, writeFileSync } from 'node:fs';
const input = process.argv[2];
if (!input) throw new Error('Usage: build-catalog.mjs /absolute/path/to/openapi.oas.json');
const spec = JSON.parse(readFileSync(input, 'utf8'));
const endpoints = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'patch', 'delete']) {
    const operation = item[method];
    if (!operation) continue;
    const filters = (operation.parameters ?? []).map(p => p.name).filter(name => name.startsWith('filter[') || name === 'sort' || name === 'include');
    endpoints.push({ method: method.toUpperCase(), path, tag: operation.tags?.[0] ?? '', ...(operation.deprecated ? { deprecated: true } : {}), ...(filters.length ? { filters } : {}) });
  }
}
writeFileSync(new URL('../catalog/endpoints.json', import.meta.url), `${JSON.stringify({ apiVersion: spec.info.version, endpoints })}\n`);
console.log(`${endpoints.length} endpoints, API ${spec.info.version}`);
