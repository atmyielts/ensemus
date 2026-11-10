import { describe, expect, it } from 'vitest';
import {
  canRaiseClass,
  DOCUMENT_STATES,
  DOCUMENT_TRANSITIONS,
  FACT_STATES,
  FACT_TRANSITIONS,
  grantAllowedFor,
  strongestClass,
} from './knowledge';
import { ledgerKeyFor, parseLedgerKey } from './tombstone-ledger';

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const ID = '6f1c2c6e-2222-4222-8222-222222222222';

describe('classes', () => {
  it('takes the strongest of a mix, and public for nothing', () => {
    expect(strongestClass([])).toBe('public');
    expect(strongestClass(['internal', 'restricted', 'public'])).toBe('restricted');
    expect(strongestClass(['internal', 'confidential'])).toBe('confidential');
  });

  it('only ever rises', () => {
    expect(canRaiseClass('internal', 'restricted')).toBe(true);
    expect(canRaiseClass('internal', 'internal')).toBe(true);
    expect(canRaiseClass('restricted', 'public')).toBe(false);
  });
});

describe('who a grant may name', () => {
  it.each([
    ['membership', 'restricted', true],
    ['team', 'confidential', true],
    ['team', 'restricted', false],
    ['organization', 'internal', true],
    ['organization', 'confidential', false],
    ['organization', 'restricted', false],
  ] as const)('%s on %s is %s', (principal, classification, allowed) => {
    expect(grantAllowedFor(principal, classification)).toBe(allowed);
  });
});

describe('lifecycles', () => {
  it('leaves a purged document nowhere to go', () => {
    expect(DOCUMENT_TRANSITIONS.purged).toEqual([]);
    for (const state of DOCUMENT_STATES.filter((s) => s !== 'purged')) {
      expect(DOCUMENT_TRANSITIONS[state]).toContain('purged');
    }
  });

  it('has no way back to proposed, and superseded and rejected are final', () => {
    for (const state of FACT_STATES) expect(FACT_TRANSITIONS[state]).not.toContain('proposed');
    expect(FACT_TRANSITIONS.superseded).toEqual([]);
    expect(FACT_TRANSITIONS.rejected).toEqual([]);
  });
});

describe('the tombstone ledger', () => {
  it('takes a knowledge source, with nothing but IDs and a type in the key', () => {
    const key = ledgerKeyFor({
      organizationId: ORG,
      targetType: 'knowledge_source',
      targetId: ID,
    });
    expect(parseLedgerKey(key)).toEqual({
      organizationId: ORG,
      targetType: 'knowledge_source',
      targetId: ID,
    });
  });
});
