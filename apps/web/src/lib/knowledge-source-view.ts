import { grantAllowedFor } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';

export type SharingPerson = { membershipId: string; name: string };
export type SharingTeam = { id: string; name: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display eligibility only. Submission still validates the principal contract, active tenant
 * membership/team and the source's fresh class in the DAL; an option is never an authority token. */
export function sourceSharingChoiceAllowed(
  classification: Classification,
  choice: string,
): boolean {
  if (choice === 'private') return true;
  if (choice === 'organization') return grantAllowedFor('organization', classification);
  if (choice.startsWith('team:'))
    return uuid.test(choice.slice(5)) && grantAllowedFor('team', classification);
  return uuid.test(choice);
}
export function sourceSharingChoices(
  classification: Classification,
  people: readonly SharingPerson[],
  teams: readonly SharingTeam[],
) {
  return [
    { value: 'private', label: 'Only me' },
    ...people.map((person) => ({ value: person.membershipId, label: person.name })),
    ...(grantAllowedFor('team', classification)
      ? teams.map((team) => ({ value: `team:${team.id}`, label: `Team: ${team.name}` }))
      : []),
    ...(grantAllowedFor('organization', classification)
      ? [{ value: 'organization', label: 'Everyone in this organization' }]
      : []),
  ];
}
