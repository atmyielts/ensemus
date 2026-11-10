// FOUND-06: the runtime contract, the generated schema and the specification must agree.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { paths } from '../generated/openapi';
import { apiErrorSchema, domainEventSchema } from './index';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

function compile(schema: object) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (a: typeof ajv) => void)(ajv);
  return ajv.compile(schema);
}

const specValidator = compile(
  json('../../../docs/specifications/schemas/domain-event.schema.json'),
);
const generatedValidator = compile(json('../generated/domain-event.schema.json'));

const valid = {
  event_id: '6f1c2c6e-1111-4111-8111-111111111111',
  event_type: 'work.created',
  schema_version: 1,
  organization_id: '6f1c2c6e-2222-4222-8222-222222222222',
  aggregate_type: 'work_unit',
  aggregate_id: '6f1c2c6e-3333-4333-8333-333333333333',
  aggregate_version: 1,
  occurred_at: '2026-11-05T10:00:00Z',
  actor: { kind: 'membership', id: 'm-1' },
  classification: 'internal',
  correlation_id: '6f1c2c6e-4444-4444-8444-444444444444',
  causation_id: null,
  payload: { work_unit_id: '6f1c2c6e-3333-4333-8333-333333333333' },
};

const { correlation_id: _omit, ...missingRequired } = valid;

const invalid: Array<[string, unknown]> = [
  ['a missing required field', missingRequired],
  ['an unknown field', { ...valid, extra: true }],
  ['a bad event type', { ...valid, event_type: 'Work Created' }],
  ['a bad tenant ID', { ...valid, organization_id: 'not-a-uuid' }],
  ['an unknown classification', { ...valid, classification: 'secret' }],
  ['an unknown actor kind', { ...valid, actor: { kind: 'robot', id: 'x' } }],
  ['a zero version', { ...valid, schema_version: 0 }],
];

describe('domain event contract', () => {
  it('accepts a valid event in all three validators', () => {
    expect(domainEventSchema.safeParse(valid).success).toBe(true);
    expect(specValidator(valid)).toBe(true);
    expect(generatedValidator(valid)).toBe(true);
  });

  it.each(invalid)('rejects %s in all three validators', (_label, event) => {
    expect(domainEventSchema.safeParse(event).success).toBe(false);
    expect(specValidator(event)).toBe(false);
    expect(generatedValidator(event)).toBe(false);
  });
});

describe('api error contract', () => {
  it('keeps to the fixed shape', () => {
    const ok = { code: 'NOT_FOUND', message: 'Not found', request_id: 'r1' };
    expect(apiErrorSchema.safeParse(ok).success).toBe(true);
    expect(apiErrorSchema.safeParse({ ...ok, stack: 'at x' }).success).toBe(false);
  });
});

describe('generated OpenAPI client types', () => {
  it('cover the public Work Unit route', () => {
    // A compile-time check: this fails typecheck if generation drifts from the spec.
    const route: keyof paths = '/organizations/{organization_id}/work-units';
    expect(route).toContain('work-units');
  });
});
