import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { apiErrorSchema, domainEventSchema } from '../src/index.ts';

const out = new URL('../generated/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries({
  'domain-event': domainEventSchema,
  'api-error': apiErrorSchema,
})) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  writeFileSync(new URL(`${name}.schema.json`, out), `${JSON.stringify(json, null, 2)}\n`);
}
