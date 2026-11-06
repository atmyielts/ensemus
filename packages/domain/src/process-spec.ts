// Visual workflows and the specs they compile to (AGENT-09, AGENT-13, ADR-031 D7). A graph is what a person
// draws, and a spec is what can run. Owned by the graph slice. Running a spec is in process-run.ts.

export const PROCESS_NODE_KINDS = [
  'start',
  'work_item',
  'agent_task',
  'human_approval',
  'external_action',
  'evidence_check',
  'end',
] as const;
export type ProcessNodeKind = (typeof PROCESS_NODE_KINDS)[number];

export type ProcessGraphNode = {
  id: string;
  kind: ProcessNodeKind;
  /** The person's own label, shown on the page. Never reaches a prompt, an event or a log. */
  label: string;
  /** Only for `agent_task`: a published agent, by definition. A run pins the version when it starts. */
  agentDefinitionId?: string;
  /** Only for `external_action`: a tool from the catalog, and the template it sends. */
  toolId?: string;
  /** Only for `human_approval`: who decides, from the run's own people. */
  approverRole?: 'process_owner' | 'starter_manager' | 'named_reviewer';
  /** Only for `evidence_check`: what has to exist. */
  evidence?: 'artifact_attached' | 'external_receipt' | 'reviewer_approved';
  /** Where it was drawn. Ignored by the compiler, so moving a box never changes a spec. */
  x: number;
  y: number;
};

export type ProcessGraphEdge = { from: string; to: string };

export type ProcessGraph = {
  schemaVersion: 1;
  nodes: readonly ProcessGraphNode[];
  edges: readonly ProcessGraphEdge[];
};

export const PROCESS_LIMITS = { maxNodes: 64, maxEdges: 128, maxLabelLength: 120 } as const;

/** One runnable step. No loops are expressible: `after` is a set of earlier steps, and it is acyclic. */
export type ProcessStep = {
  key: string;
  kind: Exclude<ProcessNodeKind, 'start' | 'end'>;
  after: readonly string[];
  labelCode: string | null;
  label: string;
  agentDefinitionId?: string;
  toolId?: string;
  approverRole?: 'process_owner' | 'starter_manager' | 'named_reviewer';
  evidence?: 'artifact_attached' | 'external_receipt' | 'reviewer_approved';
};

export type ProcessSpec = {
  schemaVersion: 1;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  steps: readonly ProcessStep[];
};

export type GraphIssue = {
  /** A node's or edge's ID, so the page can point at it. Null when the graph as a whole is at fault. */
  nodeId: string | null;
  code:
    | 'NO_START'
    | 'MANY_STARTS'
    | 'NO_END'
    | 'CYCLE'
    | 'UNREACHABLE'
    | 'DANGLING_EDGE'
    | 'DUPLICATE_ID'
    | 'TOO_LARGE'
    | 'LABEL_TOO_LONG'
    | 'UNKNOWN_KIND'
    | 'UNKNOWN_AGENT'
    | 'UNKNOWN_TOOL'
    | 'EFFECT_WITHOUT_APPROVAL'
    | 'RESTRICTED_EFFECT'
    | 'MISSING_SETTING';
};

export type CompileResult =
  | { ok: true; spec: ProcessSpec; specSha256: string; issues: readonly [] }
  | { ok: false; spec: null; specSha256: null; issues: readonly GraphIssue[] };

/**
 * Pure and deterministic. Same logic, same hash, wherever the boxes were drawn. Refuses anything that
 * cannot be made safe: any path reaching `external_action` without passing a `human_approval` first, a
 * cycle, an unreachable node, or an effect from restricted work. Implemented by the graph slice.
 */
export function compileProcessGraph(
  _graph: ProcessGraph,
  _context: {
    classification: ProcessSpec['classification'];
    agentDefinitionIds: ReadonlySet<string>;
    toolIds: ReadonlySet<string>;
  },
  _sha256: (canonical: string) => string,
): CompileResult {
  throw new Error('NOT_IMPLEMENTED');
}
