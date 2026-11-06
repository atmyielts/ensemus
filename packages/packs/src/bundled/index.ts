// The bundled workflows from docs/01-product/04-capability-catalog.md (AGENT-13). Owned by the process slice.
// Each is data: a graph that compiles like any drawn one, so it gets no special way past the compiler.
//
// Strings here make no claim about results, prices or compliance. Steps are done by people unless drawn
// otherwise: a bundled graph cannot name an agent, because an agent is a tenant's own published thing, and
// a person can still hand any step's Work Unit to one of their agents from its page. That is where a measured
// cost comes from.
import type { ProcessGraph, ProcessGraphNode, ProcessSpec } from '@ensemus/domain/process-spec';
import type { SimulationScenario } from '@ensemus/domain/simulation';

export type BundledNeed = 'email_connector' | 'accounting_connector' | 'meeting_notes';

export type BundledWorkflow = {
  key: string;
  version: number;
  name: string;
  description: string;
  classification: ProcessSpec['classification'];
  graph: ProcessGraph;
  scenario: SimulationScenario;
  /** Words that bring this to mind in the outcome composer. */
  keywords: readonly string[];
  /**
   * What has to exist for this to reach its end. An unmet need is shown on the page, and the step that needs
   * it stops honestly: nothing pretends an accounting system or a meeting service is connected.
   */
  needs: readonly BundledNeed[];
  /** Which step stops, and on what. Every need above is here, and a test holds that. */
  stepNeeds: Readonly<Record<string, BundledNeed>>;
  /** Its number in the catalog, for the page. Number 1 is M5's, so it is not one of these. */
  catalogNumber: number;
};

const place = (index: number) => ({ x: 80 + index * 180, y: 120 });

/** A straight line of steps from start to end, which is all of these need. */
function line(
  steps: readonly (Omit<ProcessGraphNode, 'x' | 'y'> & { after?: readonly string[] })[],
): ProcessGraph {
  const nodes: ProcessGraphNode[] = [
    { id: 'start', kind: 'start', label: 'Start', ...place(0) },
    ...steps.map(({ after: _after, ...step }, index) => ({ ...step, ...place(index + 1) })),
    { id: 'end', kind: 'end', label: 'End', ...place(steps.length + 1) },
  ];
  const edges = nodes.slice(1).map((node, index) => ({
    from: nodes[index]?.id ?? 'start',
    to: node.id,
  }));
  return { schemaVersion: 1, nodes, edges };
}

/**
 * Catalog number 5. First in this list on purpose, because the first simulation a new company runs is the
 * first workflow here: this one walks to its end, and shows both an approval and what would have been sent.
 */
const clientStatusUpdate: BundledWorkflow = {
  key: 'client-status-update',
  catalogNumber: 5,
  version: 1,
  name: 'Client status update',
  description:
    'A client asks how things stand. Someone gathers the evidence, drafts the update, a second person reviews it, and it is sent only after its own approval.',
  classification: 'internal',
  keywords: ['client', 'status', 'update', 'inquiry', 'progress', 'report back'],
  needs: ['email_connector'],
  stepNeeds: { send_update: 'email_connector' },
  graph: line([
    { id: 'gather_evidence', kind: 'work_item', label: 'Gather the evidence' },
    { id: 'draft_update', kind: 'work_item', label: 'Draft the update' },
    {
      id: 'review_update',
      kind: 'human_approval',
      label: 'Review the update',
      approverRole: 'process_owner',
    },
    {
      id: 'send_update',
      kind: 'external_action',
      label: 'Send the update',
      toolId: 'email.send',
    },
    {
      id: 'confirm_sent',
      kind: 'evidence_check',
      label: 'Confirm it was sent',
      evidence: 'external_receipt',
    },
  ]),
  scenario: {
    key: 'standard',
    turns: [],
    processPath: [
      'gather_evidence',
      'draft_update',
      'review_update',
      'send_update',
      'confirm_sent',
    ],
  },
};

/**
 * Catalog number 2. No meeting connector exists, so the first step needs one and stops. A scenario that
 * walked past it would be simulating a source that is not there, so this one goes nowhere.
 */
const meetingActions: BundledWorkflow = {
  key: 'meeting-actions',
  catalogNumber: 2,
  version: 1,
  name: 'Meeting actions',
  description:
    'Turns a meeting summary into actions, each with an owner and a due date, and closes when a reviewer has checked they were done.',
  classification: 'internal',
  keywords: ['meeting', 'summary', 'minutes', 'actions', 'follow up', 'owners'],
  needs: ['meeting_notes'],
  stepNeeds: { meeting_summary: 'meeting_notes' },
  graph: line([
    { id: 'meeting_summary', kind: 'work_item', label: 'Bring in the meeting summary' },
    { id: 'extract_actions', kind: 'work_item', label: 'List the actions' },
    { id: 'assign_owners', kind: 'work_item', label: 'Give each action an owner' },
    { id: 'track_due_dates', kind: 'work_item', label: 'Track the due dates' },
    {
      id: 'review_completion',
      kind: 'human_approval',
      label: 'Check the actions were done',
      approverRole: 'process_owner',
    },
    {
      id: 'verified_completion',
      kind: 'evidence_check',
      label: 'Confirm a reviewer checked',
      evidence: 'reviewer_approved',
    },
  ]),
  scenario: { key: 'standard', turns: [], processPath: [] },
};

/**
 * Catalog number 3. No accounting connector exists, so the last step needs one and stops. It only ever asks
 * for a draft in the accounting system, and nothing in Ensemus can finalize an invoice.
 */
const projectInvoiceHandoff: BundledWorkflow = {
  key: 'project-invoice-handoff',
  catalogNumber: 3,
  version: 1,
  name: 'Project invoice handoff',
  description:
    'When a project finishes, its deliverables are reviewed and handed to finance, and an invoice draft is asked for in the accounting system. It is a draft, and nothing here finalizes an invoice.',
  classification: 'confidential',
  keywords: ['project', 'completion', 'deliverable', 'finance', 'invoice', 'handoff', 'billing'],
  needs: ['accounting_connector'],
  stepNeeds: { invoice_draft: 'accounting_connector' },
  graph: line([
    {
      id: 'deliverables_attached',
      kind: 'evidence_check',
      label: 'Attach the deliverables',
      evidence: 'artifact_attached',
    },
    {
      id: 'review_deliverables',
      kind: 'human_approval',
      label: 'Review the deliverables',
      approverRole: 'process_owner',
    },
    { id: 'finance_handoff', kind: 'work_item', label: 'Hand over to finance' },
    {
      id: 'approve_draft_request',
      kind: 'human_approval',
      label: 'Approve asking for the invoice draft',
      approverRole: 'process_owner',
    },
    {
      id: 'invoice_draft',
      kind: 'external_action',
      label: 'Ask for an invoice draft in the accounting system',
      toolId: 'accounting.invoice_draft.create',
    },
  ]),
  scenario: {
    key: 'standard',
    turns: [],
    processPath: [
      'deliverables_attached',
      'review_deliverables',
      'finance_handoff',
      'approve_draft_request',
    ],
  },
};

/**
 * Catalog number 4. It holds no employment data of its own, and it grants nothing: the access step files a
 * request and someone approves that request, and whoever looks after access still does the granting.
 */
const newEmployeeOnboarding: BundledWorkflow = {
  key: 'new-employee-onboarding',
  catalogNumber: 4,
  version: 1,
  name: 'New employee onboarding',
  description:
    'Shares the policy pack, sets first tasks, files an access request for someone to approve, and finishes with the checklist. No access is granted by this workflow.',
  classification: 'confidential',
  keywords: ['new employee', 'new hire', 'onboarding', 'starter', 'policy', 'access', 'checklist'],
  needs: [],
  stepNeeds: {},
  graph: line([
    { id: 'policy_pack', kind: 'work_item', label: 'Share the policy pack' },
    { id: 'first_tasks', kind: 'work_item', label: 'Set the first tasks' },
    { id: 'access_request', kind: 'work_item', label: 'File the access request' },
    {
      id: 'approve_access_request',
      kind: 'human_approval',
      label: 'Approve the access request',
      approverRole: 'process_owner',
    },
    { id: 'onboarding_checklist', kind: 'work_item', label: 'Complete the onboarding checklist' },
    {
      id: 'checklist_attached',
      kind: 'evidence_check',
      label: 'Attach the finished checklist',
      evidence: 'artifact_attached',
    },
  ]),
  scenario: {
    key: 'standard',
    turns: [],
    processPath: [
      'policy_pack',
      'first_tasks',
      'access_request',
      'approve_access_request',
      'onboarding_checklist',
      'checklist_attached',
    ],
  },
};

export const BUNDLED_WORKFLOWS: readonly BundledWorkflow[] = [
  clientStatusUpdate,
  meetingActions,
  projectInvoiceHandoff,
  newEmployeeOnboarding,
];

export const findBundledWorkflow = (key: string): BundledWorkflow | null =>
  BUNDLED_WORKFLOWS.find((workflow) => workflow.key === key) ?? null;

/** Catalog number 1 runs on M5's own workflow and page, so this only points there. */
export const FLAGSHIP_WORKFLOW = {
  catalogNumber: 1,
  name: 'Opportunity won',
  description:
    'From a won opportunity to an onboarding plan, an approval, project setup and a kickoff document. It has its own page.',
  path: 'onboarding',
} as const;

/** Plain words for what is missing, on any page that says so. */
export const NEED_WORDS: Readonly<Record<BundledNeed, string>> = {
  email_connector: 'An email connection. Without one, the sending step stops here.',
  accounting_connector:
    'An accounting connection. Ensemus has no accounting connector yet, so this step stops and no invoice draft is asked for.',
  meeting_notes:
    'A source of meeting notes. Ensemus has no meeting connector yet, so this workflow stops at its first step.',
};

/** The code a step stops with when its need is not met. */
export const needStopCode = (need: BundledNeed) => `NEEDS_${need.toUpperCase()}`;
