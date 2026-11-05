import { describe, expect, it } from 'vitest';
import {
  actionHash,
  canonicalJson,
  checkDecision,
  checkExecution,
  type ApprovalFacts,
  type ProposedAction,
} from './approval';
import { can, canChangeWork, canReadWork, type WorkAccessFacts } from './policy';
import {
  allowedTransitions,
  canTransition,
  decideTransition,
  unmetCriteria,
  WORK_STATES,
  type TransitionFacts,
  type WorkState,
} from './work-unit';

const noEvidence = { artifactCount: 0, approvedReviewCount: 0, verifiedReceiptCount: 0 };
const facts = (from: WorkState, to: WorkState, extra: Partial<TransitionFacts> = {}) => ({
  from,
  to,
  incompletePrerequisites: 0,
  criteria: [],
  evidence: noEvidence,
  ...extra,
});

describe('work state machine', () => {
  it('matches the kernel, checked for every pair of states', () => {
    const allowed = new Set([
      'queued>ready',
      'queued>cancelled',
      'ready>running',
      'ready>cancelled',
      'running>blocked',
      'running>awaiting_approval',
      'running>verifying',
      'running>failed',
      'running>cancelled',
      'blocked>ready',
      'blocked>cancelled',
      'awaiting_approval>running',
      'awaiting_approval>cancelled',
      'verifying>completed',
      'verifying>running',
      'completed>ready',
      'failed>ready',
    ]);
    for (const from of WORK_STATES) {
      for (const to of WORK_STATES) {
        expect(canTransition(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('never lets cancelled work move again', () => {
    expect(allowedTransitions('cancelled')).toEqual([]);
  });

  it('cannot jump straight to completed from any state but verifying', () => {
    for (const from of WORK_STATES.filter((s) => s !== 'verifying')) {
      expect(decideTransition(facts(from, 'completed')).ok, from).toBe(false);
    }
  });
});

describe('transition decisions', () => {
  it('refuses ready while a prerequisite is incomplete', () => {
    expect(decideTransition(facts('queued', 'ready', { incompletePrerequisites: 1 }))).toEqual({
      ok: false,
      reason: 'PREREQUISITES_INCOMPLETE',
    });
    expect(decideTransition(facts('queued', 'ready')).ok).toBe(true);
  });

  it('refuses completion without the required evidence (QA-006)', () => {
    const criteria = [{ kind: 'artifact_exists' as const }];
    expect(decideTransition(facts('verifying', 'completed', { criteria }))).toEqual({
      ok: false,
      reason: 'EVIDENCE_MISSING',
    });
    expect(
      decideTransition(
        facts('verifying', 'completed', {
          criteria,
          evidence: { ...noEvidence, artifactCount: 1 },
        }),
      ).ok,
    ).toBe(true);
  });

  it('needs every criterion met, not just one', () => {
    const criteria = [{ kind: 'artifact_exists' as const }, { kind: 'reviewer_approved' as const }];
    expect(unmetCriteria(criteria, { ...noEvidence, artifactCount: 3 })).toEqual([
      { kind: 'reviewer_approved' },
    ]);
  });

  it('requires a reason to reopen completed work', () => {
    expect(decideTransition(facts('completed', 'ready'))).toEqual({
      ok: false,
      reason: 'REASON_REQUIRED',
    });
    expect(decideTransition(facts('completed', 'ready', { reason: '   ' })).ok).toBe(false);
    expect(
      decideTransition(facts('completed', 'ready', { reason: 'Client changed scope' })).ok,
    ).toBe(true);
  });
});

describe('approval binding', () => {
  const action: ProposedAction = {
    toolName: 'email.send',
    toolVersion: '1',
    targetRef: 'connection:abc',
    payload: { to: ['a@example.invalid'], subject: 'Kickoff', body: 'Hello' },
  };
  const hash = actionHash(action);
  const now = new Date('2026-11-05T10:00:00Z');
  const approval: ApprovalFacts = {
    status: 'pending',
    expiresAt: new Date('2026-11-05T11:00:00Z'),
    approverMembershipId: 'approver',
    requestedByMembershipId: 'requester',
    boundHash: hash,
  };
  const decision = { actorMembershipId: 'approver', shownHash: hash, now };

  it('gives the same hash whatever the key order', () => {
    const reordered: ProposedAction = {
      payload: { body: 'Hello', subject: 'Kickoff', to: ['a@example.invalid'] },
      targetRef: 'connection:abc',
      toolVersion: '1',
      toolName: 'email.send',
    };
    expect(actionHash(reordered)).toBe(hash);
  });

  it('changes the hash when anything material changes (QA-007)', () => {
    const changed = {
      ...action,
      payload: { ...(action.payload as object), to: ['b@example.invalid'] },
    };
    expect(actionHash(changed)).not.toBe(hash);
    expect(actionHash({ ...action, targetRef: 'connection:other' })).not.toBe(hash);
    expect(actionHash({ ...action, toolVersion: '2' })).not.toBe(hash);
  });

  it('keeps array order significant, since it can change meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('accepts the right approver seeing the exact action', () => {
    expect(checkDecision(approval, decision)).toEqual({ ok: true });
  });

  it.each([
    ['someone else', { ...decision, actorMembershipId: 'other' }, approval, 'WRONG_APPROVER'],
    ['a different action', { ...decision, shownHash: 'x' }, approval, 'HASH_MISMATCH'],
    ['after expiry', { ...decision, now: new Date('2026-11-05T11:00:00Z') }, approval, 'EXPIRED'],
    ['a second time', decision, { ...approval, status: 'approved' as const }, 'NOT_PENDING'],
    [
      'the requester approving themselves',
      decision,
      { ...approval, requestedByMembershipId: 'approver' },
      'SELF_APPROVAL',
    ],
  ])('refuses %s', (_label, attempt, facts, reason) => {
    expect(checkDecision(facts, attempt)).toEqual({ ok: false, reason });
  });

  describe('at execution', () => {
    const approved = {
      status: 'approved' as const,
      expiresAt: approval.expiresAt,
      boundHash: hash,
    };

    it('allows the exact approved action', () => {
      expect(checkExecution(approved, { action, now })).toEqual({ ok: true });
    });

    it('voids the approval if the action was edited afterwards', () => {
      const edited = { ...action, payload: { to: ['attacker@example.invalid'] } };
      expect(checkExecution(approved, { action: edited, now })).toEqual({
        ok: false,
        reason: 'HASH_MISMATCH',
      });
    });

    it('rechecks expiry and status', () => {
      const later = new Date('2026-11-06T00:00:00Z');
      expect(checkExecution(approved, { action, now: later }).ok).toBe(false);
      expect(checkExecution({ ...approved, status: 'denied' }, { action, now }).ok).toBe(false);
    });
  });
});

describe('permissions', () => {
  it('denies an unknown role everything', () => {
    expect(can('superuser', 'work.create')).toBe(false);
    expect(can('', 'work.create')).toBe(false);
  });

  it('keeps member management away from ordinary members', () => {
    expect(can('member', 'member.invite')).toBe(false);
    expect(can('admin', 'member.invite')).toBe(true);
    expect(can('admin', 'organization.manage')).toBe(false);
  });

  const base: WorkAccessFacts = {
    classification: 'internal',
    ownerMembershipId: 'owner-of-work',
    createdByMembershipId: 'creator',
    isAssigned: false,
  };
  const member = { membershipId: 'someone', role: 'member' };
  const orgOwner = { membershipId: 'boss', role: 'owner' };
  const onIt = { membershipId: 'owner-of-work', role: 'member' };

  it('lets any member read internal work, but not change it', () => {
    expect(canReadWork(base, member)).toBe(true);
    expect(canChangeWork(base, member)).toBe(false);
    expect(canChangeWork(base, onIt)).toBe(true);
  });

  it('limits confidential work to people on it and administrators', () => {
    const work = { ...base, classification: 'confidential' as const };
    expect(canReadWork(work, member)).toBe(false);
    expect(canReadWork(work, onIt)).toBe(true);
    expect(canReadWork(work, orgOwner)).toBe(true);
    expect(canReadWork({ ...work, isAssigned: true }, member)).toBe(true);
  });

  it('keeps restricted work from even the organization owner', () => {
    const work = { ...base, classification: 'restricted' as const };
    expect(canReadWork(work, orgOwner)).toBe(false);
    expect(canChangeWork(work, orgOwner)).toBe(false);
    expect(canReadWork(work, onIt)).toBe(true);
  });

  it('denies a role it does not know, even on public work', () => {
    const work = { ...base, classification: 'public' as const };
    expect(canReadWork(work, { membershipId: 'x', role: 'guest' })).toBe(false);
  });
});
