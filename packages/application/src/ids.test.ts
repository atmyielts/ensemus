import { describe, expect, it } from 'vitest';
import { canonicalId, idSchema } from './ids';
import { idFromRequest } from './request-id';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('the one spelling of an ID', () => {
  it('hands on a valid ID in the database spelling', () => {
    expect(idSchema.parse(ID.toUpperCase())).toBe(ID);
    expect(idSchema.parse(ID)).toBe(ID);
    expect(canonicalId(ID.toUpperCase())).toBe(ID);
  });

  it('still refuses what is not an ID', () => {
    for (const value of ['', 'nope', `${ID} `, `${ID}0`]) {
      expect(idSchema.safeParse(value).success).toBe(false);
    }
  });

  it('gives a form the same row whichever spelling its key arrives in', () => {
    expect(idFromRequest('work', ID, ID.toUpperCase(), ['x'])).toBe(
      idFromRequest('work', ID, ID, ['x']),
    );
  });
});
