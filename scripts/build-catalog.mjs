#!/usr/bin/env node
// Regenerates catalog/ from Apple's OpenAPI document:
//   npm run catalog -- /absolute/path/to/openapi.oas.json
import { readFileSync, writeFileSync } from 'node:fs';
const input = process.argv[2];
if (!input) throw new Error('Usage: build-catalog.mjs /absolute/path/to/openapi.oas.json');
const spec = JSON.parse(readFileSync(input, 'utf8'));
const schemas = spec.components.schemas;
const endpoints = [];
const wanted = new Set();
const collect = name => {
  if (wanted.has(name)) return;
  wanted.add(name);
  for (const match of JSON.stringify(schemas[name]).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) collect(match[1]);
};
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'patch', 'delete']) {
    const operation = item[method];
    if (!operation) continue;
    const filters = (operation.parameters ?? []).map(p => p.name).filter(name => !name.startsWith('fields['));
    const reference = operation.requestBody?.content?.['application/json']?.schema?.$ref;
    const body = reference?.split('/').pop();
    if (body) collect(body);
    endpoints.push({ method: method.toUpperCase(), path, tag: operation.tags?.[0] ?? '', ...(operation.deprecated ? { deprecated: true } : {}), ...(filters.length ? { filters } : {}), ...(body ? { body } : {}) });
  }
}
// Apple's win-back offer guide links each inline price to a subscription price point, but the OpenAPI
// document leaves that relationship out. Keep the bundled schema in line with the documented request.
const pricePoint = { type: 'object', properties: { subscriptionPricePoint: { type: 'object', properties: { data: { type: 'object', properties: { type: { type: 'string', enum: ['subscriptionPricePoints'] }, id: { type: 'string' } }, required: ['id', 'type'] } } } } };
for (const name of ['WinBackOfferPriceInlineCreate', 'RetentionOfferPriceInlineCreate']) {
  if (schemas[name] && !schemas[name].properties?.relationships) schemas[name].properties.relationships = pricePoint;
}
const url = name => new URL(`../catalog/${name}`, import.meta.url);
writeFileSync(url('endpoints.json'), `${JSON.stringify({ apiVersion: spec.info.version, endpoints })}\n`);
writeFileSync(url('schemas.json'), `${JSON.stringify(Object.fromEntries([...wanted].sort().map(name => [name, schemas[name]])))}\n`);
console.log(`${endpoints.length} endpoints, ${wanted.size} request schemas, API ${spec.info.version}`);
