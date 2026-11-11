// Explicit, isolated test ports for the real ToolGateway. This is not an RLS/database or M3 send test.
import { createHash } from 'node:crypto';
import type {
  AgentContext,
  ApprovalBinder,
  ExternalActionPort,
  Tx,
} from '@ensemus/application/ai-ports';
import type { ContextSource } from '@ensemus/application/ai-context-source';
import type {
  DraftEvidence,
  StoredProposal,
  ToolAudit,
  ToolRunFacts,
  ToolStepStore,
} from '@ensemus/application/ai-tool-steps';
import { createToolGateway } from '@ensemus/agent-runtime/tools';
import { strongestClassification, type AiClassification } from '@ensemus/domain/ai';
import { SOURCE_ID, SOURCE_SHA256, SOURCE_TEXT } from '../../evaluations/agents/fixtures';

export const IDS = {
  org: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  run: '11111111-1111-4111-8111-111111111111',
  work: '00000000-0000-4000-8000-000000000001',
  version: '00000000-0000-4000-8000-000000000002',
  member: '00000000-0000-4000-8000-000000000003',
  connection: '00000000-0000-4000-8000-000000000004',
  proposal: '00000000-0000-4000-8000-000000000005',
  approval: '00000000-0000-4000-8000-000000000006',
  action: '00000000-0000-4000-8000-000000000007',
};

export const syntheticEmailArgs = {
  connection_id: IDS.connection,
  email: {
    from: { address: 'sender@example.invalid' },
    to: ['recipient@example.invalid'],
    subject: 'Synthetic assurance scenario',
    text_body: 'Synthetic information for the test only.',
  },
};

type State = {
  proposal: StoredProposal;
  facts: ToolRunFacts;
  outputs: string[];
  audits: ToolAudit[];
  drafts: { classification: AiClassification; evidence: readonly DraftEvidence[] }[];
};

export function toolFixture(input: {
  toolId: string;
  args: unknown;
  facts?: Partial<ToolRunFacts>;
  halted?: boolean;
  readableSourceIds?: readonly string[];
}) {
  const context = {
    organizationId: IDS.org,
    userId: 'synthetic-user',
    membershipId: IDS.member,
    role: 'member',
    actorType: 'agent',
    agentRunId: IDS.run,
  } as AgentContext;
  const calls = {
    sourceReads: 0,
    approvalRequests: 0,
    approvalRechecks: 0,
    externalProposals: 0,
    externalReads: 0,
    objectUploads: 0,
    draftRows: 0,
  };
  let state: State = {
    proposal: {
      id: IDS.proposal,
      runId: IDS.run,
      stepId: 'synthetic-step',
      toolId: input.toolId,
      toolVersion: '1',
      payloadHash: createHash('sha256').update(JSON.stringify(input.args)).digest('hex'),
      idempotencyKey: 'synthetic-proposal-1',
      status: 'proposed',
      decisionCode: null,
      approvalId: null,
      externalActionId: null,
      args: input.args,
    },
    facts: {
      status: 'running',
      workUnitId: IDS.work,
      agentVersionId: IDS.version,
      initiatorMembershipId: IDS.member,
      initiatorRole: 'member',
      stopRequested: false,
      workStopped: false,
      inputsOpen: true,
      classification: 'internal',
      readCeiling: null,
      maxDelegationDepth: 1,
      allow: [
        'work.read',
        'artifact.read_text',
        'artifact.draft.create',
        'email.send',
        'agent.delegate',
      ],
      deny: [],
      delegated: [
        'work.read',
        'artifact.read_text',
        'artifact.draft.create',
        'email.send',
        'agent.delegate',
      ],
      ...input.facts,
    },
    outputs: [],
    audits: [],
    drafts: [],
  };
  const transaction = {} as Tx;
  const store: ToolStepStore = {
    async withTx(_context, fn) {
      const before = structuredClone(state);
      try {
        return await fn(transaction);
      } catch (error) {
        state = before;
        throw error;
      }
    },
    readRun: async () => structuredClone(state.facts),
    loadProposal: async () => structuredClone(state.proposal),
    loadProposalMetadata: async () => {
      const { args: _omitted, ...metadata } = structuredClone(state.proposal);
      return metadata;
    },
    openStep: async () => ({ stepId: 'synthetic-tool-step' }),
    lockProposal: async () => ({
      status: state.proposal.status,
      decisionCode: state.proposal.decisionCode,
    }),
    async moveProposal(_tx, change) {
      state.proposal.status = change.status;
      state.proposal.decisionCode = change.decisionCode;
    },
    async attachExternalAction(_tx, ref) {
      Object.assign(state.proposal, ref, {
        status: 'awaiting_approval',
        decisionCode: 'APPROVAL_REQUIRED',
      });
    },
    updateStep: async () => {},
    async writeOutput(_tx, _context, output) {
      state.outputs.push(output.content);
    },
    async raiseRunClass(_tx, change) {
      state.facts.classification = strongestClassification(
        state.facts.classification,
        change.atLeast,
      );
      return state.facts.classification;
    },
    recordToolCall: async () => {},
    async audit(_tx, _context, row) {
      state.audits.push(row);
    },
    // M3's SMTP connection, which every send in this fixture names (ADR-038 D6's rule, email.send first).
    readConnectionUse: async (_tx, _context, request) => ({
      connection: {
        id: request.connectionId,
        state: 'active',
        connectorType: 'email_smtp',
        ownerMembershipId: null,
        grantedScopes: [],
      },
      resource: null,
    }),
    requestSuiteRead: async () => {
      throw new Error('No suite reads in this fixture.');
    },
    readSuiteRead: async () => null,
    closeSuiteRead: async () => {
      throw new Error('No suite reads in this fixture.');
    },
    draftIdFor: () => '00000000-0000-4000-8000-00000000000d',
    noteDraftUpload: async (_tx, _context, input) => ({
      artifactId: input.draftId,
      workUnitId: input.workUnitId,
      writeId: 'test-writer',
      generation: 1,
      artifactSha256: 'test-hash',
      classification: state.facts.classification,
    }),
    async putDraft() {
      calls.objectUploads += 1;
    },
    abandonDraftUpload: async () => {},
    async insertDraft(_tx, _context, draft) {
      calls.draftRows += 1;
      state.drafts.push({ classification: draft.classification, evidence: draft.evidence });
      return { classification: draft.classification };
    },
  };
  const source: ContextSource = {
    async loadWork(_context, workId) {
      calls.sourceReads += 1;
      if (workId !== IDS.work) {
        throw Object.assign(new Error('NOT_FOUND'), { name: 'AppError', code: 'NOT_FOUND' });
      }
      return {
        id: IDS.work,
        title: 'Synthetic work',
        objective: 'Synthetic objective',
        classification: 'internal',
        clientClassification: null,
        artifactIds: [SOURCE_ID],
      };
    },
    async loadArtifactText(_context, request) {
      calls.sourceReads += 1;
      if (!(input.readableSourceIds ?? [SOURCE_ID]).includes(request.artifactId)) {
        return { refused: 'NOT_PERMITTED' };
      }
      return {
        id: request.artifactId,
        text: SOURCE_TEXT,
        sha256: SOURCE_SHA256,
        classification: 'confidential',
      };
    },
    loadTranscript: async () => [],
  };
  const externalActions: ExternalActionPort = {
    async propose() {
      calls.externalProposals += 1;
      throw new Error('No test may directly propose or send through the external action port.');
    },
    async proposeDraft() {
      calls.externalProposals += 1;
      throw new Error('No test may directly propose or send through the external action port.');
    },
    async readState() {
      calls.externalReads += 1;
      return { status: 'awaiting_approval', approvalId: IDS.approval };
    },
  };
  const approvals: ApprovalBinder = {
    async request() {
      calls.approvalRequests += 1;
      return {
        approvalId: IDS.approval,
        externalActionId: IDS.action,
        requestHash: 'a'.repeat(64),
      };
    },
    async recordDraft() {
      calls.approvalRequests += 1;
      throw new Error('No draft tool in this fixture.');
    },
    async recheck() {
      calls.approvalRechecks += 1;
      return { ok: true };
    },
  };
  const gateway = createToolGateway({
    source,
    store,
    externalActions,
    approvals,
    halt: {
      async assertRunning() {
        if (input.halted) throw new Error('AI_HALTED');
      },
    },
  });
  return {
    calls,
    state: () => structuredClone(state),
    handle: () =>
      gateway.handle(context, {
        runId: IDS.run,
        stepNumber: 3,
        workUnitId: IDS.work,
        agentVersionId: IDS.version,
      }),
  };
}
