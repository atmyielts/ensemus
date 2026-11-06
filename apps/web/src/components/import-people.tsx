import type { ImportedPersonView } from '@ensemus/application';
import { linkImportedPersonAction } from '@/server/sovereign-actions';
import { SubmitButton } from './submit-button';
import { Empty, formatDate, personLabel } from './ui';

export type LinkCandidate = { membershipId: string; name: string; email: string | null };

const ROLE_LABEL = { owner: 'an owner', admin: 'an admin', member: 'a member' } as const;

/**
 * People the archive named, none of whom an import made an account for. Someone joins through an ordinary
 * invitation, and an owner says here who they were. A role they had at the source grants nothing.
 */
export function ImportPeople({
  organizationId,
  people,
  candidates,
  everyone,
}: {
  organizationId: string;
  people: readonly ImportedPersonView[];
  /** Who could be linked now. */
  candidates: readonly LinkCandidate[];
  /** Everyone here, so that someone already linked still reads as a name. */
  everyone: readonly LinkCandidate[];
}) {
  if (people.length === 0) {
    return <Empty>No people have come from an archive yet.</Empty>;
  }
  const nameOf = new Map(everyone.map((person) => [person.membershipId, personLabel(person)]));
  return (
    <>
      <p className="muted">
        Invite each person as usual, then link them here. Linking moves what they owned to them, and
        grants no role: they keep the access they joined with.
      </p>
      <ul className="list">
        {people.map((person) => (
          <li key={person.sourceMembershipId} className="block">
            <div>
              <strong>{person.displayName}</strong> <span className="muted">{person.email}</span>
            </div>
            <p className="muted">Was {ROLE_LABEL[person.sourceRole]} where this came from.</p>
            {person.targetMembershipId ? (
              <p>
                Linked to {nameOf.get(person.targetMembershipId) ?? 'a member here'}
                {person.linkedAt && ` on ${formatDate(person.linkedAt)}`}.
              </p>
            ) : candidates.length === 0 ? (
              <p className="muted">Nobody here is free to link yet. Invite them first.</p>
            ) : (
              <form className="inline-form gap-above" action={linkImportedPersonAction}>
                <input type="hidden" name="organizationId" value={organizationId} />
                <input
                  type="hidden"
                  name="sourceMembershipId"
                  value={person.sourceMembershipId}
                />
                <label>
                  Member here
                  <select name="membershipId" required defaultValue="">
                    <option value="" disabled>
                      Choose someone
                    </option>
                    {candidates.map((candidate) => (
                      <option key={candidate.membershipId} value={candidate.membershipId}>
                        {personLabel(candidate)}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton
                  label={`Link ${person.displayName}`}
                  working="Linking"
                >
                  Link
                </SubmitButton>
              </form>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
