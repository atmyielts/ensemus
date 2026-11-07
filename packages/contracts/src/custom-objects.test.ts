import { describe, it, expect } from 'vitest';
import {
  createObjectTypeSchema,
  createObjectRecordSchema,
  updateObjectRecordSchema,
  linkObjectRecordsSchema,
} from './custom-objects';
describe('custom object HTTP contracts', () => {
  it('rejects authority fields and nested data in attributes', () => {
    expect(
      createObjectRecordSchema.safeParse({
        display_name: 'Item',
        attributes: { x: { nested: true } },
      }).success,
    ).toBe(false);
    expect(
      createObjectRecordSchema.safeParse({
        display_name: 'Item',
        attributes: {},
        owner_membership_id: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      createObjectTypeSchema.safeParse({
        slug: 'items',
        display_name: 'Items',
        classification: 'internal',
        fields: [],
        relations: [],
        role: 'owner',
      }).success,
    ).toBe(false);
  });
  it('rejects empty updates and canonicalizes relation identities', () => {
    expect(updateObjectRecordSchema.safeParse({}).success).toBe(false);
    expect(
      linkObjectRecordsSchema.parse({
        relation_key: 'related',
        to_record_id: 'ABCDEFAB-0000-4000-8000-000000000001',
      }).to_record_id,
    ).toBe('abcdefab-0000-4000-8000-000000000001');
  });
});
