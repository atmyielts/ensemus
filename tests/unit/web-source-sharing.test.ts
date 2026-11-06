import { describe, it, expect } from 'vitest';
import {
  sourceSharingChoices,
  sourceSharingChoiceAllowed,
} from '../../apps/web/src/lib/knowledge-source-view';

describe('source sharing choices follow the real classification rules', () => {
  const people = [
      { membershipId: '00000000-0000-4000-8000-000000000001', name: 'Generated person' },
    ],
    teams = [{ id: '00000000-0000-4000-8000-000000000002', name: 'Generated team' }];
  it('offers explicit named people and private access only for restricted sources', () => {
    const choices = sourceSharingChoices('restricted', people, teams);
    expect(choices.map((choice) => choice.value)).toEqual(['private', people[0]!.membershipId]);
    expect(sourceSharingChoiceAllowed('restricted', people[0]!.membershipId)).toBe(true);
    expect(sourceSharingChoiceAllowed('restricted', `team:${teams[0]!.id}`)).toBe(false);
    expect(sourceSharingChoiceAllowed('restricted', 'organization')).toBe(false);
  });
  it('offers teams for confidential sources and organization grants only for public/internal', () => {
    expect(
      sourceSharingChoices('confidential', people, teams).map((choice) => choice.value),
    ).toEqual(['private', people[0]!.membershipId, `team:${teams[0]!.id}`]);
    for (const classification of ['public', 'internal'] as const)
      expect(
        sourceSharingChoices(classification, people, teams).some(
          (choice) => choice.value === 'organization',
        ),
      ).toBe(true);
  });
  it('does not silently turn an ineligible sharing choice into a different grant', () => {
    expect(sourceSharingChoiceAllowed('restricted', 'team:not-an-id')).toBe(false);
    expect(sourceSharingChoiceAllowed('confidential', 'organization')).toBe(false);
    expect(sourceSharingChoices('restricted', [], [])).toEqual([
      { value: 'private', label: 'Only me' },
    ]);
  });
});
