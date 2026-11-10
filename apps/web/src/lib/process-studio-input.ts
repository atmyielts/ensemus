// Server form parsing. Client forms import only the erased state type from this file.
import { AppError, idSchema } from '@ensemus/application';
import { processGraphSchema } from '@ensemus/contracts/studio';
import type { ProcessGraph, ProcessGraphNode } from '@ensemus/domain/process-spec';
export type WorkflowFormState = {
  code?: string;
  values?: Record<string, string[]>;
  revision?: number;
};
export type WorkflowPointChange = {
  node: ProcessGraphNode;
  previous: string[];
  next: string[];
  replaceDirect: boolean;
};
export const workflowText = (form: FormData, key: string) => {
  const value = form.get(key);
  if (value === null) return '';
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT');
  return value;
};
export function workflowIdentifier(form: FormData, key: string) {
  const p = idSchema.safeParse(workflowText(form, key));
  if (!p.success) throw new AppError('INVALID_INPUT');
  return p.data;
}
export function workflowVersion(form: FormData) {
  const v = workflowText(form, 'version');
  if (!/^[1-9]\d{0,9}$/.test(v) || Number(v) > 2147483647) throw new AppError('INVALID_INPUT');
  return Number(v);
}
export function workflowPointId(requestKey: string) {
  const p = idSchema.safeParse(requestKey);
  if (!p.success) throw new AppError('INVALID_INPUT');
  return `point_${p.data.replaceAll('-', '')}`;
}
function pointKey(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new AppError('INVALID_INPUT');
  return value;
}
function pointKeys(form: FormData, key: string) {
  const values = form.getAll(key);
  if (values.length > 64) throw new AppError('INVALID_INPUT');
  return [
    ...new Set(
      values.map((v) => {
        if (typeof v !== 'string') throw new AppError('INVALID_INPUT');
        return pointKey(v);
      }),
    ),
  ].sort();
}
function graphValue(raw: unknown): ProcessGraph {
  const result = processGraphSchema.safeParse(raw);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return {
    schemaVersion: 1,
    nodes: result.data.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      x: n.x,
      y: n.y,
      ...(n.agentDefinitionId === undefined
        ? {}
        : { agentDefinitionId: n.agentDefinitionId.toLowerCase() }),
      ...(n.toolId === undefined ? {} : { toolId: n.toolId }),
      ...(n.approverRole === undefined ? {} : { approverRole: n.approverRole }),
      ...(n.evidence === undefined ? {} : { evidence: n.evidence }),
    })),
    edges: result.data.edges.map((e) => ({ from: e.from, to: e.to })),
  };
}
export function readWorkflowPoint(form: FormData): WorkflowPointChange {
  const kind = workflowText(form, 'kind'),
    raw: Record<string, unknown> = {
      id: pointKey(workflowText(form, 'nodeId')),
      kind,
      label: workflowText(form, 'label'),
      x: 0,
      y: 0,
    };
  const option = (name: string) => {
    const value = workflowText(form, name);
    if (value) raw[name] = value;
  };
  if (kind === 'agent_task') option('agentDefinitionId');
  if (kind === 'external_action') option('toolId');
  if (kind === 'human_approval') option('approverRole');
  if (kind === 'evidence_check') option('evidence');
  const node = graphValue({ schemaVersion: 1, nodes: [raw], edges: [] }).nodes[0];
  if (!node) throw new AppError('INVALID_INPUT');
  return {
    node,
    previous: pointKeys(form, 'previous'),
    next: pointKeys(form, 'next'),
    replaceDirect: workflowText(form, 'replaceDirect') === 'yes',
  };
}
/** Change only the requested point and incident links. Other paths and their meaning are preserved. */
export function applyWorkflowPoint(
  graph: ProcessGraph,
  change: WorkflowPointChange,
  mode: 'add' | 'update',
): ProcessGraph {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    throw new AppError('INVALID_INPUT');
  const matches = graph.nodes.filter((n) => n?.id === change.node.id),
    held = matches[0];
  if (mode === 'add' && held) throw new AppError('VERSION_CONFLICT');
  if (mode === 'update' && !held) throw new AppError('NOT_FOUND');
  if (mode === 'update' && matches.length !== 1) throw new AppError('INVALID_STATE');
  const previous = new Set(change.previous),
    next = new Set(change.next),
    node = { ...change.node, x: held?.x ?? graph.nodes.length * 160, y: held?.y ?? 120 };
  let nodes: ProcessGraphNode[];
  if (held) nodes = graph.nodes.map((n) => (n.id === held.id ? node : n));
  else {
    nodes = [...graph.nodes];
    const firstNext = nodes.findIndex((n) => next.has(n.id));
    nodes.splice(firstNext < 0 ? nodes.length : firstNext, 0, node);
  }
  // Replace the explicitly selected legacy choice before strict validation. A different unsupported
  // point still refuses the save. Validation never supplies defaults or rewrites unrelated entries.
  graphValue({ ...graph, nodes });
  let edges = graph.edges.filter(
    (e) => mode === 'add' || (e.from !== change.node.id && e.to !== change.node.id),
  );
  if (mode === 'add' && change.replaceDirect)
    edges = edges.filter((e) => !(previous.has(e.from) && next.has(e.to)));
  edges.push(
    ...change.previous.map((from) => ({ from, to: change.node.id })),
    ...change.next.map((to) => ({ from: change.node.id, to })),
  );
  const candidate = { ...graph, nodes, edges };
  graphValue(candidate);
  return candidate;
}
export function removeWorkflowPoint(graph: ProcessGraph, nodeId: string): ProcessGraph {
  const original = graphValue(graph),
    id = pointKey(nodeId);
  if (!original.nodes.some((n) => n.id === id)) throw new AppError('NOT_FOUND');
  return graphValue({
    schemaVersion: 1,
    nodes: original.nodes.filter((n) => n.id !== id),
    edges: original.edges.filter((e) => e.from !== id && e.to !== id),
  });
}
export function workflowFormValues(form: FormData) {
  const values: Record<string, string[]> = {};
  let bytes = 0;
  for (const [key, value] of form) {
    if (
      typeof value !== 'string' ||
      !/^(requestKey|version|name|classification|nodeId|kind|label|agentDefinitionId|toolId|approverRole|evidence|previous|next|replaceDirect)$/.test(
        key,
      )
    )
      continue;
    bytes += key.length + value.length;
    if (bytes > 40000) throw new AppError('INVALID_INPUT');
    (values[key] ??= []).push(value);
  }
  return values;
}

/** Remove only the specifically reviewed orphan. Never normalize or deduplicate unrelated edges. */
export function removeWorkflowConnection(
  graph: ProcessGraph,
  input: { index: number; from: string; to: string },
): ProcessGraph {
  const original = graphValue(graph),
    edge = original.edges[input.index];
  if (
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    input.index >= original.edges.length ||
    !edge ||
    edge.from !== input.from ||
    edge.to !== input.to
  )
    throw new AppError('VERSION_CONFLICT');
  if (original.nodes.some((node) => node.id === edge.from || node.id === edge.to))
    throw new AppError('INVALID_INPUT');
  return graphValue({
    ...original,
    edges: original.edges.filter((_, index) => index !== input.index),
  });
}
