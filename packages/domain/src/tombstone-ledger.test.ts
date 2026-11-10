import { describe, expect, it } from 'vitest';
import {
  ledgerKeyFor,
  ledgerKeyFromRef,
  ledgerPrefixFor,
  ledgerRef,
  parseLedgerEntry,
  parseLedgerKey,
  quarantineKeyFor,
  serializeLedgerEntry,
} from './tombstone-ledger';

const organizationId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const entry = {
  organizationId,
  targetType: 'artifact',
  targetId,
  deletedAt: new Date('2026-11-06T10:00:00.000Z'),
};
const key = ledgerKeyFor(entry);

describe('the tombstone ledger format', () => {
  it('names one key for one tombstone, under its organization', () => {
    expect(key).toBe(`tombstone-ledger/v1/${organizationId}/artifact/${targetId}.json`);
    expect(key.startsWith(ledgerPrefixFor(organizationId))).toBe(true);
    const later = { ...entry, deletedAt: new Date(0) };
    expect(ledgerKeyFor(later)).toBe(key);
  });

  it('reads back what it wrote', () => {
    expect(parseLedgerKey(key)).toEqual({ organizationId, targetType: 'artifact', targetId });
    expect(parseLedgerEntry(key, serializeLedgerEntry(entry).toString())).toEqual(entry);
  });

  it('writes IDs, a type and a time, and nothing else', () => {
    expect(Object.keys(JSON.parse(serializeLedgerEntry(entry).toString())).sort()).toEqual([
      'deleted_at',
      'organization_id',
      'target_id',
      'target_type',
      'v',
    ]);
  });

  it.each([
    ['a name where an ID goes', { targetId: 'board minutes.pdf' }],
    ['a path', { organizationId: `../${organizationId}` }],
    ['an unknown type', { targetType: 'client' }],
  ])('refuses to build a key from %s', (_, change) => {
    expect(() => ledgerKeyFor({ ...entry, ...change })).toThrow('Not a valid ledger entry');
    expect(() => serializeLedgerEntry({ ...entry, ...change })).toThrow('Not a valid ledger entry');
  });

  it.each([
    'tombstone-ledger/v1/',
    `tombstone-ledger/v1/${organizationId}/`,
    `tombstone-ledger/v1/${organizationId}/client/${targetId}.json`,
    `tombstone-ledger/v1/${organizationId}/artifact/${targetId}`,
    `tombstone-ledger/v2/${organizationId}/artifact/${targetId}.json`,
    `${organizationId}/artifacts/${targetId}`,
  ])('does not take %s for an entry', (other) => {
    expect(parseLedgerKey(other)).toBeNull();
  });

  const valid = JSON.parse(serializeLedgerEntry(entry).toString()) as Record<string, unknown>;

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', 'null'],
    ['an extra field, which is how a name would get in', { ...valid, name: 'minutes.pdf' }],
    ['a missing field', { ...valid, deleted_at: undefined }],
    ['another version', { ...valid, v: 2 }],
    ['another organization than its key', { ...valid, organization_id: targetId }],
    ['another target than its key', { ...valid, target_id: organizationId }],
    ['a time that is not one', { ...valid, deleted_at: 'yesterday' }],
  ])('refuses an object holding %s', (_, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    expect(parseLedgerEntry(key, text)).toBeNull();
  });

  it('moves a quarantined object out of the prefix everything reads and the ledger identity reaches', () => {
    const moved = quarantineKeyFor(key);
    expect(moved).toBe(
      `tombstone-ledger-quarantine/v1/${organizationId}/artifact/${targetId}.json`,
    );
    expect(moved.startsWith('tombstone-ledger/')).toBe(false);
    expect(parseLedgerKey(moved)).toBeNull();
  });

  it('gives an operator a reference that fits in a log line and leads back to the key', () => {
    const ref = ledgerRef(entry);
    expect(ref).toBe(`${organizationId}:artifact:${targetId}`);
    // The logger refuses any other characters, and the operator needs to read this there.
    expect(ref).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(ledgerKeyFromRef(ref)).toBe(key);
  });

  it.each([
    ['nothing', ''],
    ['a key', key],
    ['a name', `${organizationId}:artifact:minutes.pdf`],
    ['an unknown type', `${organizationId}:client:${targetId}`],
    ['too many parts', `${organizationId}:artifact:${targetId}:more`],
    ['too few parts', `${organizationId}:${targetId}`],
  ])('refuses %s as a reference', (_, ref) => {
    expect(ledgerKeyFromRef(ref)).toBeNull();
  });
});
