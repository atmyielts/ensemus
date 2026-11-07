import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertWithinAgentCeiling,
  assertWithinAgentProtection,
  intersectAgentReadScopes,
  parseAgentReadScope,
} from './read-scope';

describe('immutable agent company-data and Knowledge scopes', () => {
  it('uses the highest explicit data class and exact, sorted named source IDs', () => {
    const a = randomUUID(),
      b = randomUUID();
    expect(
      parseAgentReadScope([
        'data.public.read',
        'data.confidential.read',
        `knowledge.${b}.read`,
        `knowledge.${a}.read`,
        `knowledge.${b}.read`,
        'work.read',
      ]),
    ).toEqual({ ceiling: 'confidential', sourceIds: [a, b].sort() });
  });
  it('does not turn missing scopes or a legacy Work grant into broad Knowledge access', () => {
    expect(parseAgentReadScope(['work.read'])).toEqual({ ceiling: null, sourceIds: [] });
  });
  it.each([
    'data',
    'Data.internal.read',
    ' data.internal.read',
    'data.secret.read',
    'data.internal.write',
    'data.internal.read.extra',
    'knowledge',
    'knowledge.read',
    'knowledge.all.read',
    `knowledge.${randomUUID()}.write`,
  ])('refuses malformed or unsupported explicit scope %s', (scope) => {
    expect(() => parseAgentReadScope([scope])).toThrow();
  });
  it('intersects immutable parent/child grants without treating absence as a wider child grant', () => {
    const a = randomUUID(),
      b = randomUUID();
    const child = { ceiling: 'confidential' as const, sourceIds: [a, b] };
    expect(intersectAgentReadScopes(child, { ceiling: 'internal', sourceIds: [a] })).toEqual({
      ceiling: 'internal',
      sourceIds: [a],
    });
    expect(intersectAgentReadScopes(child, { ceiling: null, sourceIds: [] })).toEqual({
      ceiling: 'confidential',
      sourceIds: [],
    });
    expect(
      intersectAgentReadScopes(
        { ceiling: null, sourceIds: [a] },
        { ceiling: 'public', sourceIds: [a, b] },
      ),
    ).toEqual({ ceiling: 'public', sourceIds: [a] });
  });
  it('keeps the public company-data ceiling separate from internal manifest/result protection', () => {
    const scope = parseAgentReadScope(['data.public.read']);
    expect(() => assertWithinAgentCeiling(scope, 'public')).not.toThrow();
    expect(() => assertWithinAgentCeiling(scope, 'internal')).toThrow();
    // This helper is only used after the exhaustive company-input proof has independently passed.
    expect(() => assertWithinAgentProtection(scope, 'internal')).not.toThrow();
    expect(() => assertWithinAgentProtection(scope, 'confidential')).toThrow();
  });
  it('retains legacy M4 ABAC as the baseline when no explicit data ceiling exists', () => {
    expect(() =>
      assertWithinAgentCeiling(parseAgentReadScope(['work.read']), 'restricted'),
    ).not.toThrow();
  });
});
