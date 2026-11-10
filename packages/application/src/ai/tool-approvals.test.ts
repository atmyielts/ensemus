// AGENT-04, QA-007 agent path, FAULT-06, threat SEC-014. What binds an agent's action to a person's consent,
// against doubles for the ports and an in-memory store. The real SQL behind that store, the real roles and
// the real triggers are in tests/integration/ai-approvals.test.ts, which has not been run yet.
import { readFileSync } from 'node:fs';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { actionHash, checkDecision, type ProposedAction } from '@ensemus/domain/approval';
import { decideAction } from '@ensemus/policy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decideApproval } from '../approvals';
import { AppError } from '../errors';
import type { AgentContext, ExternalActionPort, HaltCheck } from './ports';
import {
  binderOver,
  readAgentAction,
  selectApprover,
  showInvisible,
  type ApprovalFacts,
  type ApprovalStore,
  type DecisionFacts,
  type IntentFacts,
  type MemberFacts,
  type ProposalFacts,
  type RunFacts,
  type WorkFacts,
} from './tool-approvals';

// The slice's own stub denies everything until policy-router lands, and a deny is tested on its own below.
vi.mock('@ensemus/policy', () => ({ decideAction: vi.fn() }));
const policy = vi.mocked(decideAction);

const ORG = '00000000-0000-4000-8000-000000000001';
const INITIATOR = '10000000-0000-4000-8000-000000000001';
const OWNER = '10000000-0000-4000-8000-000000000002';
const ADMIN = '10000000-0000-4000-8000-000000000003';
const ORG_OWNER = '10000000-0000-4000-8000-000000000004';
const STRANGER = '10000000-0000-4000-8000-000000000005';
const RUN = '20000000-0000-4000-8000-000000000001';
const OTHER_RUN = '20000000-0000-4000-8000-000000000002';
const WORK = '30000000-0000-4000-8000-000000000001';
const OTHER_WORK = '30000000-0000-4000-8000-000000000002';
const PROPOSAL = '40000000-0000-4000-8000-000000000001';
const APPROVAL = '50000000-0000-4000-8000-000000000001';
const OTHER_APPROVAL = '50000000-0000-4000-8000-000000000002';
const INTENT = '60000000-0000-4000-8000-000000000001';
const CONNECTION = '70000000-0000-4000-8000-000000000001';
const OTHER_CONNECTION = '70000000-0000-4000-8000-000000000002';
const VERSION = '80000000-0000-4000-8000-000000000001';
const PROFILE = '90000000-0000-4000-8000-000000000001';

const hour = 60 * 60 * 1000;
const inAnHour = () => new Date(Date.now() + hour);

const email = () => ({
  from: { address: 'sender@example.invalid' },
  to: ['client@example.invalid'],
  subject: 'Kickoff',
  text_body: 'We have started.',
});

const boundAction = (payload: unknown = email()): ProposedAction => ({
  toolName: 'email.send',
  toolVersion: '1',
  targetRef: `connection:${CONNECTION}`,
  payload,
});

const contextOf = (actorType: 'agent' | 'service' | 'user', membershipId = INITIATOR) =>
  ({
    organizationId: ORG,
    userId: 'a0000000-0000-4000-8000-000000000001',
    membershipId,
    role: 'member',
    actorType,
    ...(actorType === 'agent' ? { agentRunId: RUN } : {}),
  }) as unknown as AgentContext;

const agent = contextOf('agent');
const tx = { theOneTransaction: true } as unknown as Tx;

/** One world for one test. A test changes what it is about, and the rest stays valid. */
function world() {
  const action = boundAction();
  const hash = actionHash(action);
  return {
    proposal: {
      id: PROPOSAL,
      runId: RUN,
      toolId: 'email.send',
      toolVersion: '1',
      approvalId: APPROVAL,
      externalActionId: INTENT,
      status: 'awaiting_approval',
    } as ProposalFacts | null,
    run: {
      id: RUN,
      workUnitId: WORK,
      agentVersionId: VERSION,
      status: 'waiting_for_approval',
      initiatorMembershipId: INITIATOR,
      effectiveClassification: 'internal',
      delegatedScopes: { tools: ['email.send'] },
      boundProfileId: PROFILE,
    } as RunFacts | null,
    work: {
      id: WORK,
      status: 'running',
      classification: 'internal',
      ownerMembershipId: OWNER,
    } as WorkFacts | null,
    approval: {
      id: APPROVAL,
      workUnitId: WORK,
      status: 'approved',
      expiresAt: inAnHour(),
      actionHash: hash,
      action,
      approverMembershipId: OWNER,
      requestedByMembershipId: INITIATOR,
    } as ApprovalFacts | null,
    intent: {
      id: INTENT,
      workUnitId: WORK,
      connectionId: CONNECTION,
      approvalId: APPROVAL,
      toolName: 'email.send',
      toolVersion: '1',
      targetRef: `connection:${CONNECTION}`,
      payload: email(),
      requestHash: hash,
      status: 'ready',
    } as IntentFacts | null,
    members: new Map<string, MemberFacts>([
      [INITIATOR, { membershipId: INITIATOR, role: 'member', status: 'active' }],
      [OWNER, { membershipId: OWNER, role: 'member', status: 'active' }],
      [ADMIN, { membershipId: ADMIN, role: 'admin', status: 'active' }],
      [ORG_OWNER, { membershipId: ORG_OWNER, role: 'owner', status: 'active' }],
      [STRANGER, { membershipId: STRANGER, role: 'member', status: 'active' }],
    ]),
    assigned: [INITIATOR] as string[],
    decisions: [
      { actorMembershipId: OWNER, decision: 'approve', actionHash: hash },
    ] as DecisionFacts[],
    grants: { allow: ['email.send'], deny: [] as string[] },
    providerKind: 'local_openai_compatible' as const,
    agentRow: {
      toolId: 'email.send',
      toolVersion: '1',
      runId: RUN,
      runWorkUnitId: WORK,
      agentVersionId: VERSION,
      agentVersionNumber: 3,
      agentName: 'Work brief',
      initiatorMembershipId: INITIATOR,
      initiatorName: 'Ines Initiator',
      effectiveClassification: 'internal',
    } as Awaited<ReturnType<ApprovalStore['agentActionRow']>>,
  };
}

/** The store double, which records each call with the transaction it was given. */
function storeOver(state: ReturnType<typeof world>) {
  const calls: { method: string; tx: Tx }[] = [];
  const closed: string[] = [];
  const bound: unknown[] = [];
  const seen = <T>(method: string, given: Tx, value: T): Promise<T> => {
    calls.push({ method, tx: given });
    return Promise.resolve(value);
  };
  const store: ApprovalStore = {
    findProposal: (t, id) =>
      seen('findProposal', t, state.proposal?.id === id ? state.proposal : null),
    lockProposal: (t, id) =>
      seen('lockProposal', t, state.proposal?.id === id ? state.proposal : null),
    findRun: (t, id) => seen('findRun', t, state.run?.id === id ? state.run : null),
    lockRun: (t, id) => seen('lockRun', t, state.run?.id === id ? state.run : null),
    lockReadableWork: (t, _context, id) => {
      calls.push({ method: 'lockReadableWork', tx: t });
      if (state.work?.id !== id) return Promise.reject(new AppError('NOT_FOUND'));
      return Promise.resolve(state.work);
    },
    lockWork: (t, id) => seen('lockWork', t, state.work?.id === id ? state.work : null),
    lockApproval: (t, id) =>
      seen('lockApproval', t, state.approval?.id === id ? state.approval : null),
    lockIntent: (t, id) => seen('lockIntent', t, state.intent?.id === id ? state.intent : null),
    lockMember: (t, id) => seen('lockMember', t, state.members.get(id) ?? null),
    listElevatedMembers: (t) =>
      seen(
        'listElevatedMembers',
        t,
        [...state.members.values()].filter((m) => m.role === 'owner' || m.role === 'admin'),
      ),
    listAssigned: (t) => seen('listAssigned', t, state.assigned),
    listDecisions: (t) => seen('listDecisions', t, state.decisions),
    readGrants: (t) => seen('readGrants', t, state.grants),
    readProviderKind: (t) => seen('readProviderKind', t, state.providerKind),
    bindProposal: (t, id, ref) => {
      bound.push({ id, ...ref });
      return seen('bindProposal', t, undefined);
    },
    closeForLostAccess: (t, _context, approval) => {
      closed.push(approval.id);
      return seen('closeForLostAccess', t, undefined);
    },
    findApprovalForView: (t, id) =>
      seen('findApprovalForView', t, state.approval?.id === id ? state.approval : null),
    readableWork: (t, _context, id) => {
      calls.push({ method: 'readableWork', tx: t });
      if (state.work?.id !== id) return Promise.reject(new AppError('NOT_FOUND'));
      return Promise.resolve(state.work);
    },
    agentActionRow: (t, id) =>
      seen('agentActionRow', t, state.approval?.id === id ? state.agentRow : null),
  };
  return { store, calls, closed, bound };
}

function binderFor(state: ReturnType<typeof world>) {
  const doubles = storeOver(state);
  const propose = vi.fn<ExternalActionPort['propose']>(async () => ({
    externalActionId: INTENT,
    approvalId: APPROVAL,
    requestHash: 'hash-from-m3',
  }));
  const assertRunning = vi.fn<HaltCheck['assertRunning']>(async () => undefined);
  const binder = binderOver(doubles.store, {
    externalActions: { propose, readState: vi.fn() },
    halt: { assertRunning },
  });
  return { binder, propose, assertRunning, ...doubles };
}

const requestInput = () => ({
  proposalId: PROPOSAL,
  runId: RUN,
  workUnitId: WORK,
  connectionId: CONNECTION,
  toolId: 'email.send',
  toolVersion: '1',
  payload: { to: ['client@example.invalid'], subject: 'Kickoff', text_body: 'We have started.' },
});

const newProposal = (state: ReturnType<typeof world>) => {
  state.proposal = {
    ...(state.proposal as ProposalFacts),
    approvalId: null,
    externalActionId: null,
    status: 'proposed',
  };
  state.run = { ...(state.run as RunFacts), status: 'running' };
};

const code = (expected: string) => expect.objectContaining({ code: expected });

beforeEach(() => {
  policy.mockReset();
  policy.mockReturnValue({ decision: 'require_approval', reasonCode: 'APPROVAL_REQUIRED' });
});

describe('selectApprover: who a person is, from policy and nothing a model said', () => {
  const member = (
    membershipId: string,
    role: string,
    overrides: Partial<MemberFacts> = {},
  ): MemberFacts => ({ membershipId, role, status: 'active', ...overrides });
  const internal = { classification: 'internal', ownerMembershipId: OWNER } as const;
  const everyone = [
    member(OWNER, 'member'),
    member(ADMIN, 'admin'),
    member(ORG_OWNER, 'owner'),
    member(INITIATOR, 'admin'),
  ];

  it('asks the accountable owner when someone else started the run', () => {
    expect(
      selectApprover({
        work: internal,
        initiatorMembershipId: INITIATOR,
        members: everyone,
        assigned: [],
      }),
    ).toBe(OWNER);
  });

  it('asks an organization owner, then an admin, when the owner started the run', () => {
    const chosen = selectApprover({
      work: internal,
      initiatorMembershipId: OWNER,
      members: everyone,
      assigned: [],
    });
    expect(chosen).toBe(ORG_OWNER);
    expect(
      selectApprover({
        work: internal,
        initiatorMembershipId: OWNER,
        members: [member(OWNER, 'member'), member(ADMIN, 'admin')],
        assigned: [],
      }),
    ).toBe(ADMIN);
  });

  it('never picks the initiator, even when nobody else could do it', () => {
    expect(
      selectApprover({
        work: { classification: 'internal', ownerMembershipId: INITIATOR },
        initiatorMembershipId: INITIATOR,
        members: [member(INITIATOR, 'owner')],
        assigned: [],
      }),
    ).toBeNull();
  });

  it('sees the initiator through a change of spelling', () => {
    expect(
      selectApprover({
        work: { classification: 'internal', ownerMembershipId: 'A'.repeat(36) },
        initiatorMembershipId: 'a'.repeat(36),
        members: [member('A'.repeat(36), 'owner')],
        assigned: [],
      }),
    ).toBeNull();
  });

  it('passes over an accountable owner who is disabled', () => {
    expect(
      selectApprover({
        work: internal,
        initiatorMembershipId: INITIATOR,
        members: [member(OWNER, 'member', { status: 'disabled' }), member(ADMIN, 'admin')],
        assigned: [],
      }),
    ).toBe(ADMIN);
  });

  it('passes over an admin who is disabled, and then there is nobody', () => {
    expect(
      selectApprover({
        work: { classification: 'internal', ownerMembershipId: INITIATOR },
        initiatorMembershipId: INITIATOR,
        members: [member(ADMIN, 'admin', { status: 'disabled' })],
        assigned: [],
      }),
    ).toBeNull();
  });

  it('does not treat a plain member as a fallback, even one on the work', () => {
    expect(
      selectApprover({
        work: { classification: 'internal', ownerMembershipId: INITIATOR },
        initiatorMembershipId: INITIATOR,
        members: [member(STRANGER, 'member')],
        assigned: [STRANGER],
      }),
    ).toBeNull();
  });

  it('skips an admin who cannot read restricted work, and takes one who can', () => {
    const restricted = { classification: 'restricted', ownerMembershipId: INITIATOR } as const;
    const members = [member(ADMIN, 'admin'), member(ORG_OWNER, 'owner')];
    expect(
      selectApprover({
        work: restricted,
        initiatorMembershipId: INITIATOR,
        members,
        assigned: [],
      }),
    ).toBeNull();
    expect(
      selectApprover({
        work: restricted,
        initiatorMembershipId: INITIATOR,
        members,
        assigned: [ADMIN],
      }),
    ).toBe(ADMIN);
  });

  it('gives the same answer however the rows came back', () => {
    const facts = {
      work: { classification: 'internal', ownerMembershipId: INITIATOR },
      initiatorMembershipId: INITIATOR,
      assigned: [],
    } as const;
    const second = '10000000-0000-4000-8000-00000000000a';
    const members = [member(second, 'admin'), member(ADMIN, 'admin')];
    expect(selectApprover({ ...facts, members })).toBe(ADMIN);
    expect(selectApprover({ ...facts, members: [...members].reverse() })).toBe(ADMIN);
  });
});

describe('request: asks one person, through M3, once', () => {
  it('proposes with the owner policy picked, and binds the proposal in the same transaction', async () => {
    const state = world();
    newProposal(state);
    const { binder, propose, calls, bound } = binderFor(state);

    await expect(binder.request(tx, agent, requestInput())).resolves.toEqual({
      approvalId: APPROVAL,
      externalActionId: INTENT,
      requestHash: 'hash-from-m3',
    });

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0]?.[0]).toBe(tx);
    expect(propose.mock.calls[0]?.[2]).toEqual({
      workUnitId: WORK,
      connectionId: CONNECTION,
      toolName: 'email.send',
      toolVersion: '1',
      payload: requestInput().payload,
      approverMembershipId: OWNER,
    });
    // ADR-028: migration 0101's trigger finds the run through this link, so it cannot commit later.
    expect(bound).toEqual([
      { id: PROPOSAL, approvalId: APPROVAL, externalActionId: INTENT, requestHash: 'hash-from-m3' },
    ]);
    expect(calls.every((call) => call.tx === tx)).toBe(true);
  });

  it('takes nothing about the approver from what a model wrote', async () => {
    const state = world();
    newProposal(state);
    const { binder, propose } = binderFor(state);
    const payload = {
      ...requestInput().payload,
      approver_membership_id: INITIATOR,
      approverMembershipId: INITIATOR,
    };
    await binder.request(tx, agent, { ...requestInput(), payload });
    expect(propose.mock.calls[0]?.[2].approverMembershipId).toBe(OWNER);
  });

  it('finds the same approval on a retry, and asks nobody twice', async () => {
    const state = world();
    state.run = { ...(state.run as RunFacts), status: 'running' };
    const { binder, propose, bound } = binderFor(state);
    await expect(binder.request(tx, agent, requestInput())).resolves.toEqual({
      approvalId: APPROVAL,
      externalActionId: INTENT,
      requestHash: state.approval?.actionHash,
    });
    expect(propose).not.toHaveBeenCalled();
    expect(bound).toEqual([]);
  });

  it('refuses NO_ELIGIBLE_APPROVER, and proposes nothing, when nobody else can decide', async () => {
    const state = world();
    newProposal(state);
    state.work = { ...(state.work as WorkFacts), ownerMembershipId: INITIATOR };
    state.members = new Map([
      [INITIATOR, { membershipId: INITIATOR, role: 'owner', status: 'active' }],
    ]);
    const { binder, propose } = binderFor(state);
    await expect(binder.request(tx, agent, requestInput())).rejects.toEqual(
      code('NO_ELIGIBLE_APPROVER'),
    );
    expect(propose).not.toHaveBeenCalled();
  });

  it.each(['service', 'user'] as const)('refuses a %s context', async (actorType) => {
    const state = world();
    newProposal(state);
    const { binder, propose, calls } = binderFor(state);
    await expect(binder.request(tx, contextOf(actorType), requestInput())).rejects.toEqual(
      code('FORBIDDEN'),
    );
    expect(propose).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  const refusals: [string, (s: ReturnType<typeof world>) => void, object, string][] = [
    ['a run that is not this context', () => undefined, { runId: OTHER_RUN }, 'FORBIDDEN'],
    [
      'a proposal from another run',
      (s) => {
        s.proposal = { ...(s.proposal as ProposalFacts), runId: OTHER_RUN };
      },
      {},
      'NOT_FOUND',
    ],
    ['a proposal that does not exist', (s) => (s.proposal = null), {}, 'NOT_FOUND'],
    ['a run that does not exist', (s) => (s.run = null), {}, 'NOT_FOUND'],
    ['another Work Unit', () => undefined, { workUnitId: OTHER_WORK }, 'NOT_FOUND'],
    [
      'a run someone else started',
      (s) => {
        s.run = { ...(s.run as RunFacts), initiatorMembershipId: STRANGER };
      },
      {},
      'FORBIDDEN',
    ],
    ['a tool that does not exist', () => undefined, { toolId: 'secrets.read' }, 'TOOL_DENIED'],
    ['a tool that sends nothing', () => undefined, { toolId: 'work.read' }, 'TOOL_DENIED'],
    ['a version the tool does not have', () => undefined, { toolVersion: '2' }, 'TOOL_DENIED'],
    [
      'a proposal for another tool',
      (s) => {
        s.proposal = { ...(s.proposal as ProposalFacts), toolId: 'work.read' };
      },
      {},
      'TOOL_DENIED',
    ],
    [
      'a run that has stopped',
      (s) => {
        s.run = { ...(s.run as RunFacts), status: 'cancelled' };
      },
      {},
      'INVALID_STATE',
    ],
    [
      'a proposal already refused',
      (s) => {
        s.proposal = { ...(s.proposal as ProposalFacts), status: 'denied' };
      },
      {},
      'INVALID_STATE',
    ],
    [
      'a run whose data became restricted',
      (s) => {
        s.run = { ...(s.run as RunFacts), effectiveClassification: 'restricted' };
      },
      {},
      'RESTRICTED_NOT_ALLOWED',
    ],
  ];

  it.each(refusals)('refuses %s', async (_name, change, input, expected) => {
    const state = world();
    newProposal(state);
    change(state);
    const { binder, propose } = binderFor(state);
    await expect(binder.request(tx, agent, { ...requestInput(), ...input })).rejects.toEqual(
      code(expected),
    );
    expect(propose).not.toHaveBeenCalled();
  });

  it('refuses work the initiator cannot read as not found', async () => {
    const state = world();
    newProposal(state);
    const { binder, propose, store } = binderFor(state);
    store.lockReadableWork = () => Promise.reject(new AppError('NOT_FOUND'));
    await expect(binder.request(tx, agent, requestInput())).rejects.toEqual(code('NOT_FOUND'));
    expect(propose).not.toHaveBeenCalled();
  });

  it('stops at a kill switch before proposing anything', async () => {
    const state = world();
    newProposal(state);
    const { binder, propose, assertRunning } = binderFor(state);
    assertRunning.mockRejectedValue(new AppError('AI_HALTED'));
    await expect(binder.request(tx, agent, requestInput())).rejects.toEqual(code('AI_HALTED'));
    expect(assertRunning.mock.calls[0]?.[0]).toBe(tx);
    expect(propose).not.toHaveBeenCalled();
  });

  it.each(['deny', 'allow'] as const)(
    'refuses when policy says %s, since a send always asks a person',
    async (decision) => {
      const state = world();
      newProposal(state);
      policy.mockReturnValue({ decision, reasonCode: 'TOOL_DENIED_BY_SPEC' });
      const { binder, propose } = binderFor(state);
      await expect(binder.request(tx, agent, requestInput())).rejects.toEqual(
        code('POLICY_DENIED'),
      );
      expect(propose).not.toHaveBeenCalled();
    },
  );

  it('hands policy the grants of this version and this run', async () => {
    const state = world();
    newProposal(state);
    state.grants = { allow: ['email.send', 'work.read'], deny: ['agent.delegate'] };
    state.run = { ...(state.run as RunFacts), effectiveClassification: 'confidential' };
    await binderFor(state).binder.request(tx, agent, requestInput());
    expect(policy).toHaveBeenCalledWith({
      toolId: 'email.send',
      toolClass: 'external_write',
      allow: ['email.send', 'work.read'],
      deny: ['agent.delegate'],
      delegated: ['email.send'],
      dataClass: 'confidential',
      destructive: false,
      requiresApproval: true,
    });
  });
});

describe('recheck: the same transaction as the step acting on the approval', () => {
  const allowed = { ok: true };
  const denied = (expected: string) => ({ ok: false, code: expected });
  const recheck = (state: ReturnType<typeof world>) =>
    binderFor(state).binder.recheck(tx, agent, { proposalId: PROPOSAL });

  it('passes when everything still holds', async () => {
    await expect(recheck(world())).resolves.toEqual(allowed);
  });

  it('accepts a run still marked as waiting, and one that has resumed', async () => {
    for (const status of ['waiting_for_approval', 'running']) {
      const state = world();
      state.run = { ...(state.run as RunFacts), status };
      await expect(recheck(state)).resolves.toEqual(allowed);
    }
  });

  it('does all of its reading on the transaction it was given, locking work before approval before intent', async () => {
    const state = world();
    const { binder, calls, assertRunning } = binderFor(state);
    await binder.recheck(tx, agent, { proposalId: PROPOSAL });
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((call) => call.tx === tx)).toBe(true);
    expect(assertRunning.mock.calls[0]?.[0]).toBe(tx);
    const order = calls.map((call) => call.method);
    expect(order.indexOf('lockWork')).toBeLessThan(order.indexOf('lockApproval'));
    expect(order.indexOf('lockApproval')).toBeLessThan(order.indexOf('lockIntent'));
    expect(order).toContain('lockRun');
  });

  it('reads everything again on each call, so nothing is remembered from a passing one', async () => {
    const state = world();
    const { binder } = binderFor(state);
    await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(allowed);
    state.run = { ...(state.run as RunFacts), status: 'cancelled' };
    await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
      denied('RUN_NOT_RUNNING'),
    );
    state.run = { ...(state.run as RunFacts), status: 'running' };
    state.members.set(INITIATOR, { membershipId: INITIATOR, role: 'member', status: 'disabled' });
    await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
      denied('POLICY_DENIED'),
    );
  });

  it.each(['service', 'user'] as const)('refuses a %s context', async (actorType) => {
    const state = world();
    const { binder, calls } = binderFor(state);
    await expect(
      binder.recheck(tx, contextOf(actorType), { proposalId: PROPOSAL }),
    ).rejects.toEqual(code('FORBIDDEN'));
    expect(calls).toEqual([]);
  });

  describe('the hash binds tool, version, target and exact payload (QA-007, SEC-014)', () => {
    const changes: [string, Partial<IntentFacts>][] = [
      ['the tool', { toolName: 'email.send.v2' }],
      ['the version', { toolVersion: '2' }],
      ['the target', { targetRef: `connection:${OTHER_CONNECTION}` }],
      [
        'the target and the connection together',
        { connectionId: OTHER_CONNECTION, targetRef: `connection:${OTHER_CONNECTION}` },
      ],
      ['a connection the target does not name', { connectionId: OTHER_CONNECTION }],
      ['the recipients', { payload: { ...email(), to: ['attacker@example.invalid'] } }],
      ['an added recipient', { payload: { ...email(), bcc: ['attacker@example.invalid'] } }],
      ['the sender', { payload: { ...email(), from: { address: 'other@example.invalid' } } }],
      ['the subject', { payload: { ...email(), subject: 'Kickoff!' } }],
      ['one word of the text', { payload: { ...email(), text_body: 'We have stopped.' } }],
    ];

    it.each(changes)('changing %s voids the approval', async (_name, change) => {
      const state = world();
      state.intent = { ...(state.intent as IntentFacts), ...change };
      await expect(recheck(state)).resolves.toEqual(denied('PAYLOAD_CHANGED'));
    });

    it('does not mistake the order of keys for a change', async () => {
      const state = world();
      const { text_body, subject, to, from } = email();
      state.intent = {
        ...(state.intent as IntentFacts),
        payload: { text_body, subject, to, from },
      };
      await expect(recheck(state)).resolves.toEqual(allowed);
    });

    it('refuses an intent whose stored hash differs from the approval', async () => {
      const state = world();
      state.intent = { ...(state.intent as IntentFacts), requestHash: 'f'.repeat(64) };
      await expect(recheck(state)).resolves.toEqual(denied('PAYLOAD_CHANGED'));
    });

    it('refuses an approval whose stored action no longer gives its hash', async () => {
      const state = world();
      state.approval = {
        ...(state.approval as ApprovalFacts),
        action: boundAction({ ...email(), to: ['attacker@example.invalid'] }),
      };
      await expect(recheck(state)).resolves.toEqual(denied('PAYLOAD_CHANGED'));
    });

    it('refuses a proposal naming another version than its intent', async () => {
      const state = world();
      state.proposal = { ...(state.proposal as ProposalFacts), toolVersion: '9' };
      await expect(recheck(state)).resolves.toEqual(denied('PAYLOAD_CHANGED'));
    });

    it('refuses an intent bound before the tool moved to a new version', async () => {
      const state = world();
      const action = { ...boundAction(), toolVersion: '0' };
      const hash = actionHash(action);
      state.approval = { ...(state.approval as ApprovalFacts), action, actionHash: hash };
      state.intent = { ...(state.intent as IntentFacts), toolVersion: '0', requestHash: hash };
      state.proposal = { ...(state.proposal as ProposalFacts), toolVersion: '0' };
      state.decisions = [{ actorMembershipId: OWNER, decision: 'approve', actionHash: hash }];
      await expect(recheck(state)).resolves.toEqual(denied('PAYLOAD_CHANGED'));
    });

    it('denies after recipients were edited the proper way, which closes the old approval', async () => {
      const state = world();
      state.approval = { ...(state.approval as ApprovalFacts), status: 'cancelled' };
      state.intent = { ...(state.intent as IntentFacts), status: 'cancelled' };
      await expect(recheck(state)).resolves.toEqual(denied('APPROVAL_NOT_VALID'));
    });
  });

  describe('expiry, at the moment of acting', () => {
    it('refuses an approved action past its time, even if nothing wrote that down', async () => {
      const state = world();
      state.approval = {
        ...(state.approval as ApprovalFacts),
        expiresAt: new Date(Date.now() - 1),
      };
      await expect(recheck(state)).resolves.toEqual(denied('APPROVAL_EXPIRED'));
    });

    it('treats the exact moment of expiry as expired', async () => {
      const now = new Date('2026-11-06T12:00:00.000Z');
      vi.useFakeTimers({ now });
      try {
        const state = world();
        state.approval = { ...(state.approval as ApprovalFacts), expiresAt: now };
        await expect(recheck(state)).resolves.toEqual(denied('APPROVAL_EXPIRED'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports expired for one marked expired, and one pending past its time', async () => {
      for (const change of [
        { status: 'expired' },
        { status: 'pending', expiresAt: new Date(Date.now() - 1) },
      ]) {
        const state = world();
        state.approval = { ...(state.approval as ApprovalFacts), ...change };
        await expect(recheck(state)).resolves.toEqual(denied('APPROVAL_EXPIRED'));
      }
    });
  });

  describe('only this approval, for this run and this work', () => {
    it.each(['pending', 'denied', 'cancelled'])(
      'refuses an approval that is %s',
      async (status) => {
        const state = world();
        state.approval = { ...(state.approval as ApprovalFacts), status };
        await expect(recheck(state)).resolves.toEqual(denied('APPROVAL_NOT_VALID'));
      },
    );

    it('refuses a proposal from another run, and looks at nothing further', async () => {
      const state = world();
      state.proposal = { ...(state.proposal as ProposalFacts), runId: OTHER_RUN };
      const { binder, calls } = binderFor(state);
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('APPROVAL_NOT_VALID'),
      );
      expect(calls.map((call) => call.method)).toEqual(['findProposal']);
    });

    const unbound: [string, (s: ReturnType<typeof world>) => void][] = [
      ['a proposal that does not exist', (s) => (s.proposal = null)],
      ['a run that does not exist', (s) => (s.run = null)],
      ['work that does not exist', (s) => (s.work = null)],
      ['an approval that does not exist', (s) => (s.approval = null)],
      ['an intent that does not exist', (s) => (s.intent = null)],
      [
        'a proposal with no approval',
        (s) => {
          s.proposal = { ...(s.proposal as ProposalFacts), approvalId: null };
        },
      ],
      [
        'a proposal with no intent',
        (s) => {
          s.proposal = { ...(s.proposal as ProposalFacts), externalActionId: null };
        },
      ],
      [
        "another Work Unit's approval",
        (s) => {
          s.approval = { ...(s.approval as ApprovalFacts), workUnitId: OTHER_WORK };
        },
      ],
      [
        "another Work Unit's intent",
        (s) => {
          s.intent = { ...(s.intent as IntentFacts), workUnitId: OTHER_WORK };
        },
      ],
      [
        'an intent tied to a different approval',
        (s) => {
          s.intent = { ...(s.intent as IntentFacts), approvalId: OTHER_APPROVAL };
        },
      ],
      [
        'an approval somebody else asked for',
        (s) => {
          s.approval = { ...(s.approval as ApprovalFacts), requestedByMembershipId: STRANGER };
        },
      ],
      [
        'an approval with no one behind the request',
        (s) => {
          s.approval = { ...(s.approval as ApprovalFacts), requestedByMembershipId: null };
        },
      ],
      [
        'the initiator named as approver',
        (s) => {
          s.approval = { ...(s.approval as ApprovalFacts), approverMembershipId: INITIATOR };
        },
      ],
      [
        'an intent that was cancelled',
        (s) => {
          s.intent = { ...(s.intent as IntentFacts), status: 'cancelled' };
        },
      ],
      [
        'an intent that failed, whose approval is spent',
        (s) => {
          s.intent = { ...(s.intent as IntentFacts), status: 'failed' };
        },
      ],
      ['approved with no decision on record', (s) => (s.decisions = [])],
      [
        'a decision by someone else',
        (s) => {
          s.decisions = [
            {
              actorMembershipId: STRANGER,
              decision: 'approve',
              actionHash: s.approval?.actionHash ?? '',
            },
          ];
        },
      ],
      [
        'a decision on another hash',
        (s) => {
          s.decisions = [
            { actorMembershipId: OWNER, decision: 'approve', actionHash: 'e'.repeat(64) },
          ];
        },
      ],
      [
        'a decision that was a denial',
        (s) => {
          s.decisions = [
            {
              actorMembershipId: OWNER,
              decision: 'deny',
              actionHash: s.approval?.actionHash ?? '',
            },
          ];
        },
      ],
    ];

    it.each(unbound)('refuses %s', async (_name, change) => {
      const state = world();
      change(state);
      await expect(recheck(state)).resolves.toEqual(denied('APPROVAL_NOT_VALID'));
    });
  });

  describe('the approver still has to be able to give this', () => {
    it('closes lost restricted-work consent with the real policy, before the export refusal', async () => {
      const real = await vi.importActual<typeof import('@ensemus/policy')>('@ensemus/policy');
      policy.mockImplementation(real.decideAction);
      const state = world();
      state.work = {
        ...(state.work as WorkFacts),
        classification: 'restricted',
        ownerMembershipId: STRANGER,
      };
      const { binder, closed, propose } = binderFor(state);
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('APPROVER_LOST_ACCESS'),
      );
      expect(closed).toEqual([APPROVAL]);
      expect(propose).not.toHaveBeenCalled();
    });

    it('still denies restricted export when the approver retains access under the real policy', async () => {
      const real = await vi.importActual<typeof import('@ensemus/policy')>('@ensemus/policy');
      policy.mockImplementation(real.decideAction);
      const state = world();
      state.work = { ...(state.work as WorkFacts), classification: 'restricted' };
      const { binder, closed } = binderFor(state);
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('POLICY_DENIED'),
      );
      expect(closed).toEqual([]);
    });
    const losses: [string, (s: ReturnType<typeof world>) => void][] = [
      [
        'disabled',
        (s) => s.members.set(OWNER, { membershipId: OWNER, role: 'member', status: 'disabled' }),
      ],
      ['gone from the organization', (s) => s.members.delete(OWNER)],
      [
        'a plain member, not on confidential work',
        (s) => {
          s.work = {
            ...(s.work as WorkFacts),
            classification: 'confidential',
            ownerMembershipId: STRANGER,
          };
          s.members.set(OWNER, { membershipId: OWNER, role: 'member', status: 'active' });
        },
      ],
      [
        'taken off restricted work',
        (s) => {
          s.work = {
            ...(s.work as WorkFacts),
            classification: 'restricted',
            ownerMembershipId: STRANGER,
          };
        },
      ],
    ];

    it.each(losses)('closes the approval when they are %s', async (_name, change) => {
      const state = world();
      change(state);
      const { binder, closed, calls } = binderFor(state);
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('APPROVER_LOST_ACCESS'),
      );
      expect(closed).toEqual([APPROVAL]);
      expect(calls.at(-1)?.method).toBe('closeForLostAccess');
      expect(calls.at(-1)?.tx).toBe(tx);
    });

    it('closes a pending one too', async () => {
      const state = world();
      state.approval = { ...(state.approval as ApprovalFacts), status: 'pending' };
      state.members.delete(OWNER);
      const { binder, closed } = binderFor(state);
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('APPROVER_LOST_ACCESS'),
      );
      expect(closed).toEqual([APPROVAL]);
    });

    it('leaves alone an approval already decided against, and one past its time', async () => {
      for (const change of [
        { status: 'denied' },
        { status: 'expired' },
        { expiresAt: new Date(Date.now() - 1) },
      ]) {
        const state = world();
        state.approval = { ...(state.approval as ApprovalFacts), ...change };
        state.members.delete(OWNER);
        const { binder, closed } = binderFor(state);
        await binder.recheck(tx, agent, { proposalId: PROPOSAL });
        expect(closed).toEqual([]);
      }
    });
  });

  describe('the run still has to be running', () => {
    const stopped = [
      'queued',
      'preparing',
      'paused',
      'waiting_for_child',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'budget_exhausted',
      'policy_denied',
      'timed_out',
      'outcome_unverified',
    ];

    it.each(stopped)('refuses a run that is %s', async (status) => {
      const state = world();
      state.run = { ...(state.run as RunFacts), status };
      await expect(recheck(state)).resolves.toEqual(denied('RUN_NOT_RUNNING'));
    });

    it.each(['completed', 'failed', 'cancelled'])('refuses work that is %s', async (status) => {
      const state = world();
      state.work = { ...(state.work as WorkFacts), status };
      await expect(recheck(state)).resolves.toEqual(denied('RUN_NOT_RUNNING'));
    });

    it.each(['completed', 'failed', 'cancelled'])(
      'cannot request a new send for %s work',
      async (status) => {
        const state = world();
        newProposal(state);
        state.work = { ...(state.work as WorkFacts), status };
        const { binder, propose, bound } = binderFor(state);
        await expect(binder.request(tx, agent, requestInput())).rejects.toEqual(
          code('INVALID_STATE'),
        );
        expect(propose).not.toHaveBeenCalled();
        expect(bound).toEqual([]);
      },
    );
  });

  describe('a kill switch', () => {
    it('stops it, naming the agent version and the provider this run is bound to', async () => {
      const state = world();
      const { binder, assertRunning } = binderFor(state);
      assertRunning.mockRejectedValue(new AppError('AI_HALTED'));
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('HALTED'),
      );
      expect(assertRunning).toHaveBeenCalledWith(tx, agent, {
        agentVersionId: VERSION,
        providerKind: 'local_openai_compatible',
      });
    });

    it('is checked for a run with no profile bound yet', async () => {
      const state = world();
      state.run = { ...(state.run as RunFacts), boundProfileId: null };
      const { binder, assertRunning, calls } = binderFor(state);
      await binder.recheck(tx, agent, { proposalId: PROPOSAL });
      expect(assertRunning).toHaveBeenCalledWith(tx, agent, { agentVersionId: VERSION });
      expect(calls.map((call) => call.method)).not.toContain('readProviderKind');
    });

    it('wins over a closing approval, and closes nothing', async () => {
      const state = world();
      state.members.delete(OWNER);
      const { binder, assertRunning, closed } = binderFor(state);
      assertRunning.mockRejectedValue(new AppError('AI_HALTED'));
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('HALTED'),
      );
      expect(closed).toEqual([]);
    });

    it('does not turn anything else that goes wrong into an answer', async () => {
      const state = world();
      const { binder, assertRunning } = binderFor(state);
      assertRunning.mockRejectedValue(new Error('connection lost'));
      await expect(binder.recheck(tx, agent, { proposalId: PROPOSAL })).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('policy, as it stands now', () => {
    it.each(['deny', 'allow'] as const)('refuses when it now says %s', async (decision) => {
      policy.mockReturnValue({ decision, reasonCode: 'TOOL_DENIED_BY_SPEC' });
      await expect(recheck(world())).resolves.toEqual(denied('POLICY_DENIED'));
    });

    const facts: [string, (s: ReturnType<typeof world>) => void][] = [
      [
        'the initiator is disabled',
        (s) =>
          s.members.set(INITIATOR, {
            membershipId: INITIATOR,
            role: 'member',
            status: 'disabled',
          }),
      ],
      ['the initiator is gone', (s) => s.members.delete(INITIATOR)],
      [
        'the initiator was taken off the work',
        (s) => {
          s.assigned = [];
          s.work = { ...(s.work as WorkFacts), classification: 'confidential' };
        },
      ],
      [
        'the run belongs to someone else',
        (s) => {
          s.run = { ...(s.run as RunFacts), initiatorMembershipId: STRANGER };
        },
      ],
      [
        'the data became restricted',
        (s) => {
          s.run = { ...(s.run as RunFacts), effectiveClassification: 'restricted' };
        },
      ],
      [
        'the work is restricted',
        (s) => {
          s.work = { ...(s.work as WorkFacts), classification: 'restricted' };
        },
      ],
      [
        'the tool has gone from the list',
        (s) => {
          s.proposal = { ...(s.proposal as ProposalFacts), toolId: 'email.gone' };
        },
      ],
      [
        'the proposal is for a tool that sends nothing',
        (s) => {
          s.proposal = { ...(s.proposal as ProposalFacts), toolId: 'work.read' };
        },
      ],
    ];

    it.each(facts)('refuses when %s', async (_name, change) => {
      const state = world();
      change(state);
      await expect(recheck(state)).resolves.toEqual(denied('POLICY_DENIED'));
    });

    it('uses the role the database holds now, and not the one the context was built with', async () => {
      const state = world();
      state.work = { ...(state.work as WorkFacts), classification: 'confidential' };
      state.assigned = [];
      const context = { ...agent, role: 'owner' } as AgentContext;
      const { binder } = binderFor(state);
      await expect(binder.recheck(tx, context, { proposalId: PROPOSAL })).resolves.toEqual(
        denied('POLICY_DENIED'),
      );
    });

    it('takes the strongest class of the run and the work', async () => {
      const state = world();
      state.work = { ...(state.work as WorkFacts), classification: 'confidential' };
      state.assigned = [INITIATOR];
      state.run = { ...(state.run as RunFacts), effectiveClassification: 'public' };
      await recheck(state);
      expect(policy.mock.calls[0]?.[0]?.dataClass).toBe('confidential');
    });

    it('reads no grant a stored row got wrong as an allowance', async () => {
      const state = world();
      state.run = { ...(state.run as RunFacts), delegatedScopes: { tools: 'email.send' } };
      state.grants = { allow: [], deny: [] };
      await recheck(state);
      expect(policy.mock.calls[0]?.[0]).toMatchObject({ allow: [], delegated: [] });
    });
  });
});

describe('nobody but a person can decide (SEC-014)', () => {
  // These refuse before the database is touched, so an unusable one proves it.
  const noDatabase = {} as AppDatabase;
  const input = { approvalId: APPROVAL, decision: 'approve', shownHash: 'a'.repeat(64) } as const;

  it('refuses an agent context, which is the only one a model is ever behind', async () => {
    await expect(decideApproval(noDatabase, contextOf('agent'), input)).rejects.toEqual(
      code('FORBIDDEN'),
    );
  });

  it('refuses a service context', async () => {
    await expect(decideApproval(noDatabase, contextOf('service'), input)).rejects.toEqual(
      code('FORBIDDEN'),
    );
  });

  it('refuses the initiator as their own approver', () => {
    const hash = 'a'.repeat(64);
    expect(
      checkDecision(
        {
          status: 'pending',
          expiresAt: inAnHour(),
          approverMembershipId: INITIATOR,
          requestedByMembershipId: INITIATOR,
          boundHash: hash,
        },
        { actorMembershipId: INITIATOR, shownHash: hash, now: new Date() },
      ),
    ).toEqual({ ok: false, reason: 'SELF_APPROVAL' });
  });

  it('gives a model no way to approve: the binder has no such method', () => {
    const { binder } = binderFor(world());
    expect(Object.keys(binder).sort()).toEqual(['recheck', 'request']);
  });
});

describe('what the approval screen is given', () => {
  const read = (state: ReturnType<typeof world>, id = APPROVAL) => {
    const doubles = storeOver(state);
    return {
      ...doubles,
      result: readAgentAction(doubles.store, tx, contextOf('user', OWNER), id),
    };
  };

  it('holds initiator, agent, exact payload, data class, risk and expiry', async () => {
    const state = world();
    const view = await read(state).result;
    expect(view).toEqual({
      initiatorMembershipId: INITIATOR,
      initiatorName: 'Ines Initiator',
      agentVersionId: VERSION,
      agentVersionNumber: 3,
      agentName: 'Work brief',
      agentRunId: RUN,
      toolId: 'email.send',
      toolVersion: '1',
      dataClass: 'internal',
      riskLabel: 'external_write',
      expiresAt: state.approval?.expiresAt,
      requestHash: state.approval?.actionHash,
      action: state.approval?.action,
      email: email(),
      consistent: true,
    });
  });

  it('shows the stronger class when the run has read more than the work holds', async () => {
    const state = world();
    state.work = { ...(state.work as WorkFacts), classification: 'public' };
    state.agentRow = {
      ...(state.agentRow as NonNullable<typeof state.agentRow>),
      effectiveClassification: 'confidential',
    };
    await expect(read(state).result).resolves.toMatchObject({ dataClass: 'confidential' });
  });

  it('shows the class of the work when that is the stronger one', async () => {
    const state = world();
    state.work = { ...(state.work as WorkFacts), classification: 'confidential' };
    await expect(read(state).result).resolves.toMatchObject({ dataClass: 'confidential' });
  });

  it('shows the text as stored, and not as a schema would tidy it', async () => {
    const state = world();
    const payload = { ...email(), subject: '  Kickoff  ' };
    const action = boundAction(payload);
    state.approval = {
      ...(state.approval as ApprovalFacts),
      action,
      actionHash: actionHash(action),
    };
    const view = await read(state).result;
    expect(view?.email?.subject).toBe('  Kickoff  ');
    expect(view?.consistent).toBe(true);
  });

  it('gives no email for a payload that is not one, and leaves the exact action to show', async () => {
    const state = world();
    const action = boundAction({ anything: 'else' });
    state.approval = {
      ...(state.approval as ApprovalFacts),
      action,
      actionHash: actionHash(action),
    };
    const view = await read(state).result;
    expect(view?.email).toBeNull();
    expect(view?.action.payload).toEqual({ anything: 'else' });
  });

  const inconsistent: [string, (s: ReturnType<typeof world>) => void][] = [
    [
      'the stored action no longer gives the hash',
      (s) => {
        s.approval = { ...(s.approval as ApprovalFacts), actionHash: 'd'.repeat(64) };
      },
    ],
    [
      'the proposal names another tool',
      (s) => {
        s.agentRow = {
          ...(s.agentRow as NonNullable<typeof s.agentRow>),
          toolId: 'work.read',
        };
      },
    ],
    [
      'the proposal names another version',
      (s) => {
        s.agentRow = {
          ...(s.agentRow as NonNullable<typeof s.agentRow>),
          toolVersion: '9',
        };
      },
    ],
    [
      'the run is on other work',
      (s) => {
        s.agentRow = {
          ...(s.agentRow as NonNullable<typeof s.agentRow>),
          runWorkUnitId: OTHER_WORK,
        };
      },
    ],
  ];

  it.each(inconsistent)('says so when %s', async (_name, change) => {
    const state = world();
    change(state);
    await expect(read(state).result).resolves.toMatchObject({ consistent: false });
  });

  it('is null for an approval no agent asked for', async () => {
    const state = world();
    state.agentRow = null;
    await expect(read(state).result).resolves.toBeNull();
  });

  it('answers not found for an ID in no tenant it can see (RLS hides the row)', async () => {
    const state = world();
    state.approval = null;
    await expect(read(state).result).rejects.toEqual(code('NOT_FOUND'));
  });

  it('answers not found, before any query, for something that is no ID', async () => {
    const { result, calls } = read(world(), "1' or '1'='1");
    await expect(result).rejects.toEqual(code('NOT_FOUND'));
    expect(calls).toEqual([]);
  });

  it('answers not found, and reads nothing more, for someone who cannot read the work', async () => {
    const state = world();
    const doubles = storeOver(state);
    doubles.store.readableWork = () => Promise.reject(new AppError('NOT_FOUND'));
    await expect(
      readAgentAction(doubles.store, tx, contextOf('user', STRANGER), APPROVAL),
    ).rejects.toEqual(code('NOT_FOUND'));
    expect(doubles.calls.map((call) => call.method)).toEqual(['findApprovalForView']);
  });

  it('cannot read a prompt, because this file names no way to', () => {
    const source = readFileSync(new URL('./tool-approvals.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/stepPayloads|step_payloads|tool-steps/);
  });
});

describe('showInvisible', () => {
  it('leaves ordinary text alone, line breaks included', () => {
    const text = 'Dear client,\n\tWe have started. Größe 日本語 ok.';
    expect(showInvisible(text)).toBe(text);
  });

  it('writes out what would otherwise fool a reader', () => {
    expect(showInvisible('pay‮txt.exe')).toBe('pay\\u{202E}txt.exe');
    expect(showInvisible('a​b')).toBe('a\\u{200B}b');
    expect(showInvisible('a\u0000b\u007F')).toBe('a\\u{0}b\\u{7F}');
    expect(showInvisible('﻿hello')).toBe('\\u{FEFF}hello');
    expect(showInvisible('⁦x⁩')).toBe('\\u{2066}x\\u{2069}');
    expect(showInvisible('­soft')).toBe('\\u{AD}soft');
  });
});

// So a typed context in a test above stays honest about what the real one is.
const _agentIsATenantContext: TenantContext = agent;
void _agentIsATenantContext;
