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
  | 'member.view_email'
  | 'connection.manage'
  // Governed AI (ADR-028 FD-20). Named roles arrive in M7. Until then these map to owner and admin.
  | 'model.manage'
  | 'model.activate'
  | 'agent.publish'
  | 'agent.run'
  | 'agent.stop'
  | 'ai.halt'
  | 'budget.manage'
  | 'usage.view'
  // M5 (ADR-029 D2). None of these reads a document: only a source's ACL gives that.
  | 'knowledge.add'
  | 'knowledge.manage'
  | 'knowledge.review_fact'
  | 'egress.view'
  | 'client_onboarding.start'
  | 'organization.export'
  | 'organization.import'
  | 'license.manage'
  | 'license.view'
  // M8 (ADR-032). Money, retention and leaving are the organization's own decisions.
  | 'billing.view'
  | 'billing.manage'
  | 'retention.manage'
  | 'legal_hold.manage'
  | 'offboarding.manage'
  | 'break_glass.authorize'
  | 'support.use';

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
    'connection.manage',
    'model.manage',
    'model.activate',
    'agent.publish',
    'agent.run',
    'agent.stop',
    'ai.halt',
    'budget.manage',
    'usage.view',
    'knowledge.add',
    'knowledge.manage',
    'knowledge.review_fact',
    'egress.view',
    'client_onboarding.start',
    // An archive holds nearly all of a tenant, and a license is the customer's, so these are the owner's.
    'organization.export',
    'organization.import',
    'license.manage',
    'license.view',
    'billing.view',
    'billing.manage',
    'retention.manage',
    'legal_hold.manage',
    'offboarding.manage',
    'break_glass.authorize',
    'support.use',
  ]),
  admin: new Set([
    'member.invite',
    'member.manage',
    'team.manage',
    'client.manage',
    'project.manage',
    'work.create',
    'member.view_email',
    'connection.manage',
    'model.manage',
    'model.activate',
    'agent.publish',
    'agent.run',
    'agent.stop',
    'ai.halt',
    'budget.manage',
    'usage.view',
    'knowledge.add',
    'knowledge.manage',
    'knowledge.review_fact',
    'egress.view',
    'client_onboarding.start',
    'license.view',
    'billing.view',
    'billing.manage',
    'retention.manage',
    'support.use',
  ]),
  member: new Set(['client.manage', 'project.manage', 'work.create', 'knowledge.add', 'support.use']),
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
