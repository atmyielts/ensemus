import { randomUUID } from 'node:crypto';
import {
  listDirectory,
  listInvitations,
  listTeams,
  listWorkWithDisabledOwner,
} from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConfirmForm } from '@/components/confirm-form';
import { InviteForm } from '@/components/invite-form';
import { SubmitButton } from '@/components/submit-button';
import { ActionLink, Empty, ErrorNotice, formatDate, PageHead, StatusBadge } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import {
  addTeamMemberAction,
  confirmInvitationAction,
  createTeamAction,
  disableMemberAction,
  recoverWorkOwnerAction,
  removeTeamMemberAction,
  revokeInvitationAction,
  setRoleAction,
  setTeamParentAction,
} from '@/server/work-actions';

export const metadata = { title: 'People and teams | Ensemus' };

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** The first letter of a name, for the circle beside it. The same rule as the account circle. */
const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? '?';

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
    <ul className={parentId ? 'list team-list nested' : 'list team-list'}>
      {level.map((team) => {
        const onTeam = new Set(team.members.map((member) => member.membershipId));
        const available = candidates.filter((member) => !onTeam.has(member.membershipId));
        const below = withDescendants(teams, team.id);
        const parents = teams.filter((other) => !below.has(other.id));
        const canAdd = canManage && available.length > 0;
        const canMove = canManage && (parents.length > 0 || team.parentId !== null);
        const fields = (
          <>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="teamId" value={team.id} />
          </>
        );
        return (
          <li key={team.id} className="block">
            <div className="team-head">
              <strong>{team.name}</strong>
              {team.membersHidden ? (
                <small>
                  {team.memberCount === 1 ? '1 person.' : `${team.memberCount} people.`} Who is on a
                  team is shown to the people on it, and to owners and admins.
                </small>
              ) : (
                team.members.length === 0 && (
                  <small>
                    {canManage
                      ? 'Nobody on it yet. Add the first person below.'
                      : 'Nobody on it yet.'}
                  </small>
                )
              )}
            </div>
            {!team.membersHidden && team.members.length > 0 && (
              <ul className="team-members" aria-label={`People on ${team.name}`}>
                {team.members.map((member) => (
                  <li key={member.membershipId}>
                    <span className="person-avatar small" aria-hidden="true">
                      {initialOf(member.name)}
                    </span>
                    <span>{member.name}</span>
                    {canManage && (
                      <form action={removeTeamMemberAction}>
                        {fields}
                        <input type="hidden" name="membershipId" value={member.membershipId} />
                        <SubmitButton
                          className="ghost"
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
            {(canAdd || canMove) && (
              <div className="team-controls">
                {canAdd && (
                  <form className="inline-form" action={addTeamMemberAction}>
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
                    <SubmitButton className="secondary" label={`Add to ${team.name}`}>
                      Add
                    </SubmitButton>
                  </form>
                )}
                {canMove && (
                  <form className="inline-form" action={setTeamParentAction}>
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
                    <SubmitButton className="secondary" label={`Move ${team.name}`}>
                      Move
                    </SubmitButton>
                  </form>
                )}
              </div>
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
    <ul className="list people-list">
      {invitations.map((invitation) => {
        const state = invitationState(invitation);
        const open = state === 'Waiting' || state === 'Asking to join';
        return (
          <li key={invitation.id} className="block">
            <div className="person">
              <span className="person-avatar" aria-hidden="true">
                {initialOf(invitation.email)}
              </span>
              <span className="person-who">
                <span className="person-name">{invitation.email}</span>
                <small>
                  Invited as {ROLE_LABEL[invitation.role] ?? invitation.role}
                  {open && `, open until ${formatDate(invitation.expiresAt)}`}
                </small>
              </span>
              <span className="person-access">
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
                      className="ghost"
                      label={`Withdraw the invitation for ${invitation.email}`}
                    >
                      Withdraw
                    </SubmitButton>
                  </form>
                )}
              </span>
            </div>
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
  const [members, teams, invitations, ownerless] = await Promise.all([
    listDirectory(database, context),
    listTeams(database, context),
    canInvite ? listInvitations(database, context) : [],
    canManage ? listWorkWithDisabledOwner(database, context) : { visible: [], hidden: [] },
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
      <PageHead
        title="People and teams"
        description="Everyone in your organization, what they can do here, and the teams they work in."
        actions={
          canInvite && (
            <ActionLink href="#invite-heading" variant="secondary">
              Invite someone
            </ActionLink>
          )
        }
      />
      <ErrorNotice code={error} />
      <div className="stack">
        <section className="card" aria-labelledby="members-heading">
          <header className="section-heading">
            <div>
              <h2 id="members-heading">Members</h2>
              <p>
                Owners look after the whole organization, including billing and who else is an
                owner. Admins invite people and set up teams, clients and connections. Members do
                their own work and see what is shared with them.
              </p>
              {!seesEmail && <p>Email addresses are only shown to owners and admins.</p>}
            </div>
          </header>
          <ul className="list people-list">
            {members.map((member) => (
              <li key={member.membershipId} className="block">
                <div className="person">
                  <span className="person-avatar" aria-hidden="true">
                    {initialOf(member.name)}
                  </span>
                  <span className="person-who">
                    <span className="person-name">
                      {member.name}
                      {member.membershipId === context.membershipId && (
                        <>
                          {' '}
                          <small>(you)</small>
                        </>
                      )}
                    </span>
                    {seesEmail && <small className="email">{member.email}</small>}
                  </span>
                  <span className="person-access">
                    {member.status !== 'active' && <span className="badge">Disabled</span>}
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
                          <SubmitButton
                            className="secondary"
                            label={`Save access for ${member.name}`}
                          >
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
                      <span className="person-role">
                        <span>{ROLE_LABEL[member.role] ?? member.role}</span>
                        {canManage && member.status === 'active' && (
                          <small>
                            {member.role === 'owner' && activeOwners.length === 1
                              ? 'The only owner, so this stays as it is'
                              : 'Only an owner can change this'}
                          </small>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {canInvite && (
          <section className="card" aria-labelledby="invite-heading">
            <header className="section-heading">
              <div>
                <h2 id="invite-heading">Invite someone</h2>
                <p>
                  Enter their email address and choose what they can do. Ensemus makes a private
                  link for you to send them, and they join when they open it.
                </p>
              </div>
            </header>
            <InviteForm organizationId={organizationId} />
            {open.length > 0 && (
              <div className="divided">
                <h3>Waiting for an answer</h3>
                <InvitationList invitations={open} org={org} />
              </div>
            )}
            {past.length > 0 && (
              <details className={open.length > 0 ? 'gap-above' : 'divided'}>
                <summary>Past invitations ({past.length})</summary>
                <InvitationList invitations={past} org={org} />
              </details>
            )}
          </section>
        )}

        {ownerless.visible.length + ownerless.hidden.length > 0 && (
          <section className="card" aria-labelledby="ownerless-heading">
            <header className="section-heading">
              <div>
                <h2 id="ownerless-heading">Work whose owner was disabled</h2>
                <p>Each of these needs someone new to answer for it.</p>
              </div>
            </header>
            <ul className="list">
              {ownerless.visible.map((work) => (
                <li key={work.id}>
                  <Link href={`/o/${organizationId}/work/${work.id}`}>{work.title}</Link>
                  <StatusBadge status={work.status} />
                </li>
              ))}
              {ownerless.hidden.map((work) => (
                <li key={work.id} className="block">
                  <div className="spread">
                    <span>
                      Restricted work nobody active can open
                      <br />
                      <small className="technical-reference">Reference {work.id}</small>
                    </span>
                    <StatusBadge status={work.status} />
                  </div>
                  <div className="gap-above-small">
                    <ConfirmForm
                      action={recoverWorkOwnerAction}
                      fields={
                        <>
                          {org}
                          <input type="hidden" name="id" value={work.id} />
                          <input type="hidden" name="version" value={work.version} />
                        </>
                      }
                      summary="Choose a new owner"
                      summaryLabel={`Choose a new owner for restricted work ${work.id}`}
                      consequence="Make this person its accountable owner. Nobody active can open this work now. They will be able to read everything in it, and you will not, unless you choose yourself. This goes in the audit log, and any other owners are told."
                      confirmLabel="Make them the owner"
                    >
                      <label>
                        New owner
                        <select name="membershipId" required defaultValue="">
                          <option value="" disabled>
                            Choose a person
                          </option>
                          {teamCandidates.map((member) => (
                            <option key={member.membershipId} value={member.membershipId}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </ConfirmForm>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card" aria-labelledby="teams-heading">
          <header className="section-heading">
            <div>
              <h2 id="teams-heading">Teams</h2>
              <p>Teams show who works together. A team can sit inside a larger one.</p>
            </div>
          </header>
          {teams.length === 0 ? (
            <Empty title="No teams yet">
              {canManageTeams
                ? 'Create the first one below, then add the people who work in it.'
                : 'An owner or admin can create them.'}
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
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <label>
                Team name
                <input name="name" required maxLength={200} autoComplete="off" />
              </label>
              {teams.length > 0 && (
                <label>
                  Inside another team (optional)
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
              <SubmitButton className="secondary">Create team</SubmitButton>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
