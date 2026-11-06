import { listDirectory, listInvitations, listTeams } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import type { ReactNode } from 'react';
import { ConfirmForm } from '@/components/confirm-form';
import { InviteForm } from '@/components/invite-form';
import { SubmitButton } from '@/components/submit-button';
import { Empty, ErrorNotice, formatDate, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import {
  addTeamMemberAction,
  confirmInvitationAction,
  createTeamAction,
  disableMemberAction,
  removeTeamMemberAction,
  revokeInvitationAction,
  setRoleAction,
  setTeamParentAction,
} from '@/server/work-actions';

export const metadata = { title: 'People and teams | Ensemus' };

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

type Team = Awaited<ReturnType<typeof listTeams>>[number];
type Candidate = { membershipId: string; name: string };

/** The team, and every team under it: none of them can become its parent without making a loop. */
function withDescendants(teams: Team[], id: string): Set<string> {
  const found = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const team of teams) {
      if (team.parentId && found.has(team.parentId) && !found.has(team.id)) {
        found.add(team.id);
        grew = true;
      }
    }
  }
  return found;
}

function TeamTree({
  teams,
  parentId,
  organizationId,
  candidates,
  canManage,
}: {
  teams: Team[];
  parentId: string | null;
  organizationId: string;
  candidates: Candidate[];
  canManage: boolean;
}) {
  const level = teams.filter((team) => team.parentId === parentId);
  if (level.length === 0) return null;
  return (
    <ul className={parentId ? 'list nested' : 'list'}>
      {level.map((team) => {
        const onTeam = new Set(team.members.map((member) => member.membershipId));
        const available = candidates.filter((member) => !onTeam.has(member.membershipId));
        const below = withDescendants(teams, team.id);
        const parents = teams.filter((other) => !below.has(other.id));
        const fields = (
          <>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="teamId" value={team.id} />
          </>
        );
        return (
          <li key={team.id} className="block">
            <strong>{team.name}</strong>
            {team.members.length === 0 ? (
              <>
                <br />
                <small>
                  {canManage ? 'No members yet. Add the first below.' : 'No members yet.'}
                </small>
              </>
            ) : (
              <ul className="list">
                {team.members.map((member) => (
                  <li key={member.membershipId}>
                    <span>{member.name}</span>
                    {canManage && (
                      <form action={removeTeamMemberAction}>
                        {fields}
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <SubmitButton
                          className="quiet"
                          label={`Remove ${member.name} from ${team.name}`}
                        >
                          Remove
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && available.length > 0 && (
              <form className="inline-form gap-above" action={addTeamMemberAction}>
                {fields}
                <label>
                  Add to {team.name}
                  <select name="membershipId" required defaultValue="">
                    <option value="" disabled>
                      Choose a person
                    </option>
                    {available.map((member) => (
                      <option key={member.membershipId} value={member.membershipId}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton className="quiet" label={`Add to ${team.name}`}>
                  Add
                </SubmitButton>
              </form>
            )}
            {canManage && (parents.length > 0 || team.parentId) && (
              <form className="inline-form gap-above" action={setTeamParentAction}>
                {fields}
                <label>
                  Move {team.name} under
                  <select name="parentId" defaultValue={team.parentId ?? ''}>
                    <option value="">No parent team</option>
                    {parents.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.name}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton className="quiet" label={`Move ${team.name}`}>
                  Move
                </SubmitButton>
              </form>
            )}
            <TeamTree
              teams={teams}
              parentId={team.id}
              organizationId={organizationId}
              candidates={candidates}
              canManage={canManage}
            />
          </li>
        );
      })}
    </ul>
  );
}

function invitationState(invitation: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  claimedAt: Date | null;
  expiresAt: Date;
}) {
  if (invitation.acceptedAt) return 'Accepted';
  if (invitation.revokedAt) return 'Withdrawn';
  if (invitation.expiresAt.getTime() <= Date.now()) return 'Expired';
  if (invitation.claimedAt) return 'Asking to join';
  return 'Waiting';
}

type Invitation = Awaited<ReturnType<typeof listInvitations>>[number];

function InvitationList({ invitations, org }: { invitations: Invitation[]; org: ReactNode }) {
  return (
    <ul className="list">
      {invitations.map((invitation) => {
        const state = invitationState(invitation);
        const open = state === 'Waiting' || state === 'Asking to join';
        return (
          <li key={invitation.id}>
            <span>
              {invitation.email}{' '}
              <small>
                {ROLE_LABEL[invitation.role] ?? invitation.role}
                {open && `, until ${formatDate(invitation.expiresAt)}`}
              </small>
            </span>
            <span className="row">
              <span className={`badge ${open ? 'attention' : ''}`}>{state}</span>
              {state === 'Asking to join' && (
                <ConfirmForm
                  action={confirmInvitationAction}
                  fields={
                    <>
                      {org}
                      <input type="hidden" name="invitationId" value={invitation.id} />
                    </>
                  }
                  summary="Confirm"
                  summaryLabel={`Confirm ${invitation.email}`}
                  consequence={`Let ${invitation.email} join. Someone holding this link signed in with this address, but nothing has proven the address is theirs. Only confirm if you have checked with them.`}
                  confirmLabel="Confirm"
                  confirmFullLabel={`Confirm ${invitation.email}`}
                />
              )}
              {open && (
                <form action={revokeInvitationAction}>
                  {org}
                  <input type="hidden" name="invitationId" value={invitation.id} />
                  <SubmitButton
                    className="quiet"
                    label={`Withdraw the invitation for ${invitation.email}`}
                  >
                    Withdraw
                  </SubmitButton>
                </form>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const canManage = can(context.role, 'member.manage');
  const canInvite = can(context.role, 'member.invite');
  const canManageTeams = can(context.role, 'team.manage');
  const seesEmail = can(context.role, 'member.view_email');
  const [members, teams, invitations] = await Promise.all([
    listDirectory(database, context),
    listTeams(database, context),
    canInvite ? listInvitations(database, context) : [],
  ]);

  const iAmOwner = context.role === 'owner';
  const activeOwners = members.filter((m) => m.role === 'owner' && m.status === 'active');
  // Only an owner can change an owner, and an organization has to keep at least one.
  const canChange = (member: (typeof members)[number]) =>
    canManage &&
    member.status === 'active' &&
    (iAmOwner || member.role !== 'owner') &&
    !(member.role === 'owner' && activeOwners.length === 1);
  const roleChoices = iAmOwner ? ['owner', 'admin', 'member'] : ['admin', 'member'];
  const org = <input type="hidden" name="organizationId" value={organizationId} />;
  const teamCandidates = members.filter((member) => member.status === 'active');
  const isOpen = (invitation: Invitation) => {
    const state = invitationState(invitation);
    return state === 'Waiting' || state === 'Asking to join';
  };
  const open = invitations.filter(isOpen);
  const past = invitations.filter((invitation) => !isOpen(invitation));

  return (
    <>
      <PageHead title="People and teams" description="Who is here, and how they are organized." />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="members-heading">
          <h2 id="members-heading">Members</h2>
          {!seesEmail && (
            <p className="muted">Email addresses are only shown to owners and admins.</p>
          )}
          <ul className="list">
            {members.map((member) => (
              <li key={member.membershipId} className="block">
                <div className="member">
                  <div className="who">
                    {member.name}
                    {member.membershipId === context.membershipId && <small> (you)</small>}
                    {seesEmail && <small className="email">{member.email}</small>}
                  </div>
                  <span className={`badge ${member.status === 'active' ? 'done' : ''}`}>
                    {member.status === 'active' ? 'Active' : 'Disabled'}
                  </span>
                  {canManage && canChange(member) ? (
                    <>
                      <form className="access-form" action={setRoleAction}>
                        {org}
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <select
                          name="role"
                          defaultValue={member.role}
                          aria-label={`Access for ${member.name}`}
                        >
                          {roleChoices.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </option>
                          ))}
                        </select>
                        <SubmitButton className="quiet" label={`Save access for ${member.name}`}>
                          Save
                        </SubmitButton>
                      </form>
                      {/* Disabling yourself would lock you out at once. */}
                      {member.membershipId !== context.membershipId && (
                        <ConfirmForm
                          action={disableMemberAction}
                          fields={
                            <>
                              {org}
                              <input
                                type="hidden"
                                name="membershipId"
                                value={member.membershipId}
                              />
                            </>
                          }
                          summary="Disable"
                          summaryLabel={`Disable ${member.name}`}
                          consequence={`Disable ${member.name} now. They lose access on their next click, the invitations they made stop working, and open reviews they were asked for close.`}
                          confirmLabel="Disable"
                        />
                      )}
                    </>
                  ) : (
                    <small>
                      {ROLE_LABEL[member.role] ?? member.role}
                      {canManage &&
                        member.status === 'active' &&
                        (member.role === 'owner' && activeOwners.length === 1
                          ? ', the only owner'
                          : ', and only an owner can change this')}
                    </small>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {canInvite && (
          <section className="card" aria-labelledby="invitations-heading">
            <h2 id="invitations-heading">Invitations</h2>
            {open.length === 0 ? (
              <p className="muted">
                {past.length === 0 ? 'Nobody has been invited yet.' : 'None open at the moment.'}
              </p>
            ) : (
              <InvitationList invitations={open} org={org} />
            )}
            {past.length > 0 && (
              <details className="gap-above">
                <summary>Past invitations ({past.length})</summary>
                <InvitationList invitations={past} org={org} />
              </details>
            )}
            <div className="divided">
              <h3>Invite someone</h3>
              <InviteForm organizationId={organizationId} />
            </div>
          </section>
        )}

        <section className="card" aria-labelledby="teams-heading">
          <h2 id="teams-heading">Teams</h2>
          {teams.length === 0 ? (
            <Empty>
              {canManageTeams
                ? 'No teams yet. Create the first one below.'
                : 'No teams yet. An admin can create them.'}
            </Empty>
          ) : (
            <TeamTree
              teams={teams}
              parentId={null}
              organizationId={organizationId}
              candidates={teamCandidates}
              canManage={canManageTeams}
            />
          )}
          {canManageTeams && (
            <form className="inline-form divided" action={createTeamAction}>
              {org}
              <label>
                Team name
                <input name="name" required maxLength={200} autoComplete="off" />
              </label>
              {teams.length > 0 && (
                <label>
                  Part of (optional)
                  <select name="parentId" defaultValue="">
                    <option value="">No parent team</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <SubmitButton className="quiet">Create team</SubmitButton>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
