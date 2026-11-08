import { readFileSync } from 'node:fs';

type Schema = Record<string, any>;
let cached: Record<string, Schema> | undefined;
const schemas = () => cached ??= JSON.parse(readFileSync(new URL('../catalog/schemas.json', import.meta.url), 'utf8'));
export const requestSchema = (name: string): Schema | undefined => schemas()[name];
const follow = (schema: Schema): Schema => {
  const name = schema.$ref?.split('/').pop();
  if (!name) return schema;
  const target = schemas()[name];
  if (!target) throw new Error(`Unknown schema ${name}.`);
  return { ...target, ...(schema.nullable ? { nullable: true } : {}) };
};
const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
/**
 * Checks a request body against Apple's OpenAPI schema and lists every problem.
 * Unknown properties are refused so a typo cannot be silently ignored by Apple.
 */
export function checkSchema(raw: Schema, value: unknown, path = 'body'): string[] {
  const schema = follow(raw);
  if (value === null) return schema.nullable ? [] : [`${path} must not be null`];
  if (schema.allOf) return schema.allOf.flatMap((part: Schema) => checkSchema({ ...part, additionalProperties: true }, value, path));
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (schema[key] && !schema.properties) {
      const results = schema[key].map((part: Schema) => checkSchema(part, value, path));
      if (!results.some((problems: string[]) => !problems.length)) return [`${path} matches no allowed form: ${results[0]?.[0] ?? 'invalid'}`];
      return [];
    }
  }
  const problems: string[] = [];
  const actual = typeOf(value);
  const expected = schema.type === 'integer' ? 'number' : schema.type;
  if (expected && actual !== expected) return [`${path} must be ${schema.type}, got ${actual}`];
  if (schema.type === 'integer' && !Number.isInteger(value)) problems.push(`${path} must be an integer`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (schema.format === 'date' && typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`${path} must be YYYY-MM-DD`);
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((item, i) => problems.push(...checkSchema(schema.items, item, `${path}[${i}]`)));
  if (actual === 'object' && schema.properties) {
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (object[required] === undefined) problems.push(`${path}.${required} is required`);
    for (const [key, item] of Object.entries(object)) {
      const child = schema.properties[key];
      if (child) problems.push(...checkSchema(child, item, `${path}.${key}`));
      else if (schema.additionalProperties !== true) problems.push(`${path}.${key} is not a known field`);
    }
    // Apple's anyOf beside properties lists alternative required relationships, not extra fields.
    if (schema.anyOf && !schema.anyOf.some((part: Schema) => !missingRequired(part, object).length)) problems.push(`${path} is missing fields required by every allowed form: ${missingRequired(schema.anyOf[0], object).join(', ')}`);
  }
  return problems;
}
function missingRequired(part: Schema, object: Record<string, unknown>, prefix = ''): string[] {
  const missing = (part.required ?? []).filter((key: string) => object[key] === undefined).map((key: string) => `${prefix}${key}`);
  for (const [key, child] of Object.entries<Schema>(part.properties ?? {})) {
    if (typeOf(object[key]) === 'object') missing.push(...missingRequired(child, object[key] as Record<string, unknown>, `${prefix}${key}.`));
  }
  return missing;
}
export function assertValidBody(schemaName: string, value: unknown): void {
  const schema = requestSchema(schemaName);
  if (!schema) throw new Error(`Unknown request schema ${schemaName}.`);
  const problems = checkSchema(schema, value);
  if (problems.length) throw new Error(`Request does not match ${schemaName}:\n- ${problems.slice(0, 20).join('\n- ')}`);
}
