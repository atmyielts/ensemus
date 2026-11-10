// Visual workflows and the specs they compile to (AGENT-09, AGENT-13, ADR-031 D7). A graph is what a person
// draws, and a spec is what can run. Owned by the graph slice. Running a spec is in process-run.ts.
import { canonicalJson } from './approval';

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
  graph: ProcessGraph,
  context: {
    classification: ProcessSpec['classification'];
    agentDefinitionIds: ReadonlySet<string>;
    toolIds: ReadonlySet<string>;
  },
  sha256: (canonical: string) => string,
): CompileResult {
  // A graph can come from a stored row or a pack, so nothing about its shape is taken on trust. Reading it
  // here is what makes this total: everything below works on values already known to be what they claim.
  const raw = (isObject(graph) ? graph : {}) as Record<string, unknown>;
  const rawNodes: readonly unknown[] = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges: readonly unknown[] = Array.isArray(raw.edges) ? raw.edges : [];

  // Past the limit nothing else is looked at. The person has to cut it down first, and the work here stays
  // bounded however large a graph someone sends.
  if (rawNodes.length > PROCESS_LIMITS.maxNodes || rawEdges.length > PROCESS_LIMITS.maxEdges) {
    return refuse([{ nodeId: null, code: 'TOO_LARGE' }]);
  }

  const issues: GraphIssue[] = [];
  if (raw.schemaVersion !== 1) issues.push({ nodeId: null, code: 'UNKNOWN_KIND' });

  const nodes: ProcessGraphNode[] = [];
  for (const item of rawNodes) {
    if (isObject(item) && typeof item.id === 'string') nodes.push(item as ProcessGraphNode);
    else issues.push({ nodeId: null, code: 'UNKNOWN_KIND' });
  }
  const edges: ProcessGraphEdge[] = [];
  for (const item of rawEdges) {
    if (isObject(item) && typeof item.from === 'string' && typeof item.to === 'string') {
      edges.push({ from: item.from, to: item.to });
    } else {
      issues.push({ nodeId: null, code: 'DANGLING_EDGE' });
    }
  }

  // A repeated ID is refused, and until then it counts against the graph: it is an effect if any box with
  // that ID is one, and an approval only if every box with that ID is one. So the order boxes are listed in
  // cannot change the answer, and a duplicate can never pose as the approval an effect needed.
  const kindsOf = new Map<string, Set<string>>();
  for (const node of nodes) {
    const kinds = kindsOf.get(node.id);
    if (kinds) {
      kinds.add(String(node.kind));
      issues.push({ nodeId: node.id, code: 'DUPLICATE_ID' });
    } else {
      kindsOf.set(node.id, new Set([String(node.kind)]));
    }
  }
  const isOnly = (id: string, kind: ProcessNodeKind) => {
    const kinds = kindsOf.get(id);
    return kinds?.size === 1 && kinds.has(kind);
  };
  const isAny = (id: string, kind: ProcessNodeKind) => kindsOf.get(id)?.has(kind) === true;

  for (const node of nodes) issues.push(...nodeIssues(node, context));

  const ids = [...kindsOf.keys()];
  const starts = ids.filter((id) => isAny(id, 'start'));
  const ends = ids.filter((id) => isAny(id, 'end'));
  if (starts.length === 0) issues.push({ nodeId: null, code: 'NO_START' });
  if (starts.length > 1) {
    for (const id of starts) issues.push({ nodeId: id, code: 'MANY_STARTS' });
  }
  if (ends.length === 0) issues.push({ nodeId: null, code: 'NO_END' });

  // Only edges between boxes that exist can carry anything. The others are reported, at whichever end is
  // there, so the page can show them next to something.
  const next = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const before = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const { from, to } of edges) {
    const fromKnown = next.get(from);
    const toKnown = before.get(to);
    if (!fromKnown || !toKnown) {
      issues.push({ nodeId: fromKnown ? from : toKnown ? to : from, code: 'DANGLING_EDGE' });
      continue;
    }
    fromKnown.add(to);
    toKnown.add(from);
    // Nothing happens after an end, and nothing comes before a start.
    if (isAny(from, 'end')) issues.push({ nodeId: from, code: 'DANGLING_EDGE' });
    if (isAny(to, 'start')) issues.push({ nodeId: to, code: 'DANGLING_EDGE' });
  }

  const walk = (from: readonly string[], stopAt: (id: string) => boolean = () => false) => {
    const seen = new Set(from);
    const stack = [...from];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (stopAt(id)) continue;
      for (const following of next.get(id) ?? []) {
        if (!seen.has(following)) {
          seen.add(following);
          stack.push(following);
        }
      }
    }
    return seen;
  };

  for (const id of ids) {
    // A box is on a loop when it can be reached again from what follows it. Bounded by the limits above.
    if (walk([...(next.get(id) ?? [])]).has(id)) issues.push({ nodeId: id, code: 'CYCLE' });
  }

  if (starts.length > 0) {
    const reachable = walk(starts);
    for (const id of ids) {
      if (!reachable.has(id)) issues.push({ nodeId: id, code: 'UNREACHABLE' });
    }
    if (ends.length > 0) {
      for (const id of reachable) {
        // With no end at all that has already been said once, for the whole graph.
        if (!isAny(id, 'end') && next.get(id)?.size === 0) {
          issues.push({ nodeId: id, code: 'NO_END' });
        }
      }
    }

    // The rule that matters most. This walk does not continue past an approval, so what it reaches is
    // exactly what some path gets to with no approval on the way, and a branch cannot hide behind another
    // branch's approval. It goes on through effects, since one with no approval does not vouch for the next.
    const unapproved = walk(starts, (id) => isOnly(id, 'human_approval'));
    for (const id of ids) {
      if (isAny(id, 'external_action') && unapproved.has(id)) {
        issues.push({ nodeId: id, code: 'EFFECT_WITHOUT_APPROVAL' });
      }
    }
  }

  const stepNodes = nodes.filter((node) => node.kind !== 'start' && node.kind !== 'end');
  if (issues.length === 0 && stepNodes.length === 0) {
    issues.push({ nodeId: null, code: 'MISSING_SETTING' });
  }
  if (issues.length > 0) return refuse(issues);

  const spec: ProcessSpec = {
    schemaVersion: 1,
    classification: context.classification,
    steps: stepNodes
      .map((node) =>
        toStep(
          node,
          [...(before.get(node.id) ?? [])].filter((id) => !isAny(id, 'start')).sort(byCodeUnit),
        ),
      )
      .sort((a, b) => byCodeUnit(a.key, b.key)),
  };
  return { ok: true, spec, specSha256: sha256(canonicalJson(spec)), issues: [] };
}

const NODE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const APPROVER_ROLES: readonly unknown[] = ['process_owner', 'starter_manager', 'named_reviewer'];
const EVIDENCE_KINDS: readonly unknown[] = [
  'artifact_attached',
  'external_receipt',
  'reviewer_approved',
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Not `localeCompare`: an order that depends on the machine's language would change a hash. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What is wrong with one box, looked at alone. */
function nodeIssues(
  node: ProcessGraphNode,
  context: {
    classification: ProcessSpec['classification'];
    agentDefinitionIds: ReadonlySet<string>;
    toolIds: ReadonlySet<string>;
  },
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (code: GraphIssue['code']) => issues.push({ nodeId: node.id, code });
  // A key travels where a label may not, through Temporal and into logs, so it can hold no sentence.
  if (!NODE_ID.test(node.id)) add('MISSING_SETTING');
  if (!PROCESS_NODE_KINDS.includes(node.kind)) add('UNKNOWN_KIND');

  const label = typeof node.label === 'string' ? node.label : '';
  if (label.length > PROCESS_LIMITS.maxLabelLength) add('LABEL_TOO_LONG');
  if (node.kind !== 'start' && node.kind !== 'end' && label.trim() === '') add('MISSING_SETTING');

  const named = (value: unknown): value is string => typeof value === 'string' && value !== '';
  switch (node.kind) {
    case 'agent_task':
      if (!named(node.agentDefinitionId)) add('MISSING_SETTING');
      else if (!context.agentDefinitionIds.has(node.agentDefinitionId)) add('UNKNOWN_AGENT');
      // An agent is not offered restricted data at all (ADR-031 D5), and this compiler cannot see what its
      // tools might send. So it counts as an effect here, on the side of refusing.
      if (context.classification === 'restricted') add('RESTRICTED_EFFECT');
      break;
    case 'external_action':
      if (!named(node.toolId)) add('MISSING_SETTING');
      else if (!context.toolIds.has(node.toolId)) add('UNKNOWN_TOOL');
      if (context.classification === 'restricted') add('RESTRICTED_EFFECT');
      break;
    case 'human_approval':
      if (!APPROVER_ROLES.includes(node.approverRole)) add('MISSING_SETTING');
      break;
    case 'evidence_check':
      if (!EVIDENCE_KINDS.includes(node.evidence)) add('MISSING_SETTING');
      break;
    default:
      break;
  }
  return issues;
}

/** Only the setting this kind uses, so one left over from an earlier choice cannot change what runs. */
function toStep(node: ProcessGraphNode, after: readonly string[]): ProcessStep {
  const step: ProcessStep = {
    key: node.id,
    kind: node.kind as ProcessStep['kind'],
    after,
    labelCode: null,
    label: node.label,
  };
  if (node.kind === 'agent_task' && node.agentDefinitionId) {
    step.agentDefinitionId = node.agentDefinitionId;
  }
  if (node.kind === 'external_action' && node.toolId) step.toolId = node.toolId;
  if (node.kind === 'human_approval' && node.approverRole) step.approverRole = node.approverRole;
  if (node.kind === 'evidence_check' && node.evidence) step.evidence = node.evidence;
  return step;
}

/** Every issue once, in one order, whatever order the graph listed things in. */
function refuse(issues: readonly GraphIssue[]): CompileResult {
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.nodeId === null ? '0' : `1${issue.nodeId}`}\u0000${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ordered = unique.sort(
    (a, b) =>
      byCodeUnit(
        a.nodeId === null ? '' : `n${a.nodeId}`,
        b.nodeId === null ? '' : `n${b.nodeId}`,
      ) || byCodeUnit(a.code, b.code),
  );
  return { ok: false, spec: null, specSha256: null, issues: ordered };
}

/**
 * The same rules, on a finished spec. A compiled graph always passes. This is for the moment of writing an
 * immutable row, so that a pack, a bundled workflow or a bug in a caller has no way to store a spec the
 * compiler would have refused, including one written by hand. Pure, and bounded by the steps it is given.
 */
export function verifyProcessSpec(spec: ProcessSpec): readonly GraphIssue[] {
  const issues: GraphIssue[] = [];
  const stepsByKey = new Map<string, ProcessStep>();
  for (const step of spec.steps) {
    if (stepsByKey.has(step.key)) issues.push({ nodeId: step.key, code: 'DUPLICATE_ID' });
    else stepsByKey.set(step.key, step);
    if (
      spec.classification === 'restricted' &&
      (step.kind === 'external_action' || step.kind === 'agent_task')
    ) {
      issues.push({ nodeId: step.key, code: 'RESTRICTED_EFFECT' });
    }
    for (const earlier of step.after) {
      if (!spec.steps.some((other) => other.key === earlier)) {
        issues.push({ nodeId: step.key, code: 'DANGLING_EDGE' });
      }
    }
  }

  // Walks in the order the `after` sets allow. A step is covered when it is an approval, or when everything
  // before it is covered and there is something before it: the same "every path" rule as the compiler's.
  const covered = new Map<string, boolean>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const step of stepsByKey.values()) {
      if (covered.has(step.key)) continue;
      const known = step.after.filter((key) => stepsByKey.has(key));
      if (!known.every((key) => covered.has(key))) continue;
      const passed =
        step.kind === 'human_approval' ||
        (step.after.length > 0 &&
          known.length === step.after.length &&
          known.every((key) => covered.get(key)));
      covered.set(step.key, passed);
      moved = true;
    }
  }
  for (const step of stepsByKey.values()) {
    if (!covered.has(step.key)) issues.push({ nodeId: step.key, code: 'CYCLE' });
    else if (step.kind === 'external_action' && !covered.get(step.key)) {
      issues.push({ nodeId: step.key, code: 'EFFECT_WITHOUT_APPROVAL' });
    }
  }
  return issues;
}
