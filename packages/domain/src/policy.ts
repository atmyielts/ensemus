// Default-deny permissions. Pure and testable, and never asks a model (ADR-012).

export type Role = 'owner' | 'admin' | 'member';
export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';

export type Capability =
  | 'organization.manage'
  | 'member.invite'
  | 'member.manage'
  | 'team.manage'
  | 'client.manage'
  | 'project.manage'
  | 'work.create'
  | 'work.recover_owner'
  | 'member.view_email';

const GRANTS: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set([
    'organization.manage',
    'member.invite',
    'member.manage',
    'team.manage',
    'client.manage',
    'project.manage',
    'work.create',
    'work.recover_owner',
    'member.view_email',
  ]),
  admin: new Set([
    'member.invite',
    'member.manage',
    'team.manage',
    'client.manage',
    'project.manage',
    'work.create',
    'member.view_email',
  ]),
  member: new Set(['client.manage', 'project.manage', 'work.create']),
};

export function isRole(value: string): value is Role {
  return value === 'owner' || value === 'admin' || value === 'member';
}

export function can(role: string, capability: Capability): boolean {
  return isRole(role) && GRANTS[role].has(capability);
}

export type WorkAccessFacts = {
  classification: Classification;
  ownerMembershipId: string | null;
  isAssigned: boolean;
};

export type Viewer = { membershipId: string; role: string };

/**
 * The accountable owner and the people assigned. Nothing else counts, so the page can list everyone
 * this grants access to, and each of them can be removed. Having created the work grants nothing:
 * the creator is assigned when the work is created, like anyone else.
 */
function isInvolved(work: WorkAccessFacts, viewer: Viewer): boolean {
  return work.ownerMembershipId === viewer.membershipId || work.isAssigned;
}

/**
 * Who can see a Work Unit. Restricted work is limited to the people on it, and being an owner or
 * admin of the organization does not change that (docs/04-security/01-security-blueprint.md §5).
 */
export function canReadWork(work: WorkAccessFacts, viewer: Viewer): boolean {
  if (!isRole(viewer.role)) return false;
  switch (work.classification) {
    case 'public':
    case 'internal':
      return true;
    case 'confidential':
      return isInvolved(work, viewer) || viewer.role === 'owner' || viewer.role === 'admin';
    case 'restricted':
      return isInvolved(work, viewer);
  }
}

/** Who can change a Work Unit. Reading it is not enough. */
export function canChangeWork(work: WorkAccessFacts, viewer: Viewer): boolean {
  if (!canReadWork(work, viewer)) return false;
  return isInvolved(work, viewer) || viewer.role === 'owner' || viewer.role === 'admin';
}

/**
 * Who answers for a Work Unit: its accountable owner, and organization owners and admins who can see
 * it. Someone only assigned can work on it and move it along. Changing who is responsible, who else is
 * on it, or stopping it for good is not theirs to do (WORK-03). Restricted work stays out of reach of
 * an organization admin who is not on it, because this starts from being able to read it.
 */
export function canManageWork(work: WorkAccessFacts, viewer: Viewer): boolean {
  if (!canReadWork(work, viewer)) return false;
  return (
    work.ownerMembershipId === viewer.membershipId ||
    viewer.role === 'owner' ||
    viewer.role === 'admin'
  );
}
