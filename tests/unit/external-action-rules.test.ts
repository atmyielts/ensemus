// ADR-027 D1: the state machine exists in code and in reviewed SQL, since the web and the worker share a
// role, and the contracts and OpenAPI repeat its names. These keep every copy the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { externalActionStatusSchema } from '@ensemus/contracts/external-actions';
import {
  canTransitionExternalAction,
  EXTERNAL_ACTION_STATUSES,
  EXTERNAL_ACTION_TRANSITIONS,
  isSettledExternalAction,
} from '@ensemus/domain/external-action';
import { spec } from '../helpers/openapi';
import { repoRoot } from '../helpers/stack';

const security = readFileSync(
  join(repoRoot, 'packages/database/migrations/0013_verified_external_actions_security.sql'),
  'utf8',
);
const tables = readFileSync(
  join(repoRoot, 'packages/database/migrations/0012_verified_external_actions.sql'),
  'utf8',
);

describe('the external action state machine', () => {
  it('is the same table in the domain and in the trigger', () => {
    const inSql = Object.fromEntries(
      [...security.matchAll(/WHEN '([a-z_]+)' THEN NEW\.status IN \(([^)]+)\)/g)].map(
        ([, from, to]) => [
          from,
          (to ?? '').split(',').map((state) => state.trim().replaceAll("'", '')),
        ],
      ),
    );
    const moving = Object.entries(EXTERNAL_ACTION_TRANSITIONS).filter(([, to]) => to.length > 0);
    expect(Object.keys(inSql).sort()).toEqual(moving.map(([from]) => from).sort());
    for (const [from, to] of moving) expect(inSql[from], from).toEqual([...to]);
  });

  it('lists the same states in the domain, the table, the contract and the API', () => {
    const inTable = /"status" in \('([^)]+)'\)/.exec(
      tables.slice(tables.indexOf('external_actions_status_check')),
    )?.[1];
    expect(inTable?.split("','")).toEqual([...EXTERNAL_ACTION_STATUSES]);
    expect(externalActionStatusSchema.options).toEqual([...EXTERNAL_ACTION_STATUSES]);
    const schemas = spec.components.schemas as unknown as Record<string, { enum: string[] }>;
    expect(schemas.ExternalActionStatus?.enum).toEqual([...EXTERNAL_ACTION_STATUSES]);
  });

  it('has no way back to a send from anything that could already have sent', () => {
    expect(canTransitionExternalAction('unknown', 'ready')).toBe(false);
    expect(canTransitionExternalAction('unknown', 'sending')).toBe(false);
    expect(canTransitionExternalAction('sent', 'sending')).toBe(false);
    expect(canTransitionExternalAction('failed', 'sending')).toBe(false);
    expect(canTransitionExternalAction('failed', 'ready')).toBe(false);
  });

  it('counts unknown as waiting for a person, not as finished', () => {
    expect(isSettledExternalAction('unknown')).toBe(false);
    for (const status of ['sent', 'failed', 'cancelled'] as const) {
      expect(isSettledExternalAction(status)).toBe(true);
    }
  });
});
