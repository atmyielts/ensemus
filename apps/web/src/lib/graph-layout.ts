// Read-only projection of saved points/connections. Geometry never changes the persisted graph.
import { WORKFLOW_KIND_NAMES } from './process-studio-present';

export type MapNode = {
  index: number;
  id: string | null;
  label: string;
  kind: string | null;
  knownKind: boolean;
  duplicate: boolean;
  cyclic: boolean;
  unresolved: boolean;
  editTarget: string;
  incoming: number[];
  outgoing: number[];
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
};
export type MapEdge = {
  index: number;
  from: string | null;
  to: string | null;
  source: number | null;
  target: number | null;
  issue: 'missing' | 'ambiguous' | null;
  repeated: boolean;
  cyclic: boolean;
  path: string;
};
export type GraphLayout = {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  visual: boolean;
  oversized: boolean;
  hasCycles: boolean;
};
const WIDTH = 224,
  GAP = 112,
  ROW_GAP = 40,
  PADDING = 24,
  LINE = 22;
const known = new Set<string>(Object.keys(WORKFLOW_KIND_NAMES));
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : null);
export const workflowPointAnchor = (index: number) => `workflow-point-${index + 1}`;

/** Wrap without truncation or changing the saved label, including long words and Unicode. */
export function mapLabelLines(label: string): string[] {
  const normalized = label.trim().replace(/\s+/gu, ' '),
    segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(normalized)].map(
      (part) => part.segment,
    );
  if (!segments.length) return ['Unnamed saved point'];
  const lines: string[] = [];
  for (let offset = 0; offset < segments.length;) {
    let end = Math.min(offset + 12, segments.length);
    if (end < segments.length) {
      for (let candidate = end; candidate > offset + 4; candidate--)
        if (segments[candidate - 1] === ' ') {
          end = candidate;
          break;
        }
    }
    const line = segments.slice(offset, end).join('').trim();
    if (line) lines.push(line);
    offset = end;
    while (segments[offset] === ' ') offset++;
  }
  return lines;
}

/** Every saved array entry survives, including duplicate identities and unresolved endpoints.
 * Only unambiguous real connections get drawn; no ghost executable point is invented. */
export function layoutWorkflowGraph(input: unknown): GraphLayout {
  const graph = record(input),
    rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [],
    rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const groups = new Map<string, number[]>();
  const nodes: MapNode[] = rawNodes.map((raw, index) => {
    const value = record(raw),
      id = text(value.id),
      label = text(value.label) ?? 'Unnamed saved point',
      kind = text(value.kind),
      lines = mapLabelLines(label);
    if (id !== null) groups.set(id, [...(groups.get(id) ?? []), index]);
    return {
      index,
      id,
      label,
      kind,
      knownKind: kind !== null && known.has(kind),
      duplicate: false,
      cyclic: false,
      unresolved: false,
      editTarget: workflowPointAnchor(index),
      incoming: [],
      outgoing: [],
      lines,
      x: 0,
      y: 0,
      width: WIDTH,
      height: 86 + lines.length * LINE,
      rank: 0,
    };
  });
  for (const node of nodes) {
    const group = node.id === null ? [] : (groups.get(node.id) ?? []);
    node.duplicate = group.length > 1;
    node.editTarget = workflowPointAnchor(group[0] ?? node.index);
  }
  const pairs = new Set<string>();
  const edges: MapEdge[] = rawEdges.map((raw, index) => {
    const value = record(raw),
      from = text(value.from),
      to = text(value.to),
      sources = from === null ? [] : (groups.get(from) ?? []),
      targets = to === null ? [] : (groups.get(to) ?? []);
    const issue =
        sources.length === 0 || targets.length === 0
          ? 'missing'
          : sources.length !== 1 || targets.length !== 1
            ? 'ambiguous'
            : null,
      source = sources.length === 1 ? (sources[0] ?? null) : null,
      target = targets.length === 1 ? (targets[0] ?? null) : null;
    const pair = JSON.stringify([from, to]),
      repeated = pairs.has(pair);
    pairs.add(pair);
    if (issue) {
      for (const point of [...sources, ...targets]) {
        const node = nodes[point];
        if (node) node.unresolved = true;
      }
    } else if (source !== null && target !== null) {
      nodes[source]?.outgoing.push(target);
      nodes[target]?.incoming.push(source);
    }
    return { index, from, to, source, target, issue, repeated, cyclic: false, path: '' };
  });
  const oversized = nodes.length > 64 || edges.length > 128;
  if (!nodes.length || oversized)
    return { nodes, edges, width: 0, height: 0, visual: false, oversized, hasCycles: false };
  // Strongly connected groups keep malformed loops visible and make rank assignment total.
  const adjacency = nodes.map((node) => [...new Set(node.outgoing)].sort((a, b) => a - b)),
    seen = new Map<number, number>(),
    low = new Map<number, number>(),
    stack: number[] = [],
    active = new Set<number>(),
    components: number[][] = [];
  let clock = 0;
  const visit = (at: number) => {
    seen.set(at, clock);
    low.set(at, clock++);
    stack.push(at);
    active.add(at);
    for (const next of adjacency[at] ?? []) {
      if (!seen.has(next)) {
        visit(next);
        low.set(at, Math.min(low.get(at) ?? 0, low.get(next) ?? 0));
      } else if (active.has(next)) low.set(at, Math.min(low.get(at) ?? 0, seen.get(next) ?? 0));
    }
    if (low.get(at) === seen.get(at)) {
      const group: number[] = [];
      for (;;) {
        const item = stack.pop();
        if (item === undefined) break;
        active.delete(item);
        group.push(item);
        if (item === at) break;
      }
      components.push(group.sort((a, b) => a - b));
    }
  };
  for (const node of nodes) if (!seen.has(node.index)) visit(node.index);
  const componentOf = new Map<number, number>();
  components.forEach((group, index) => group.forEach((point) => componentOf.set(point, index)));
  const nextGroups = components.map(() => new Set<number>()),
    indegree = components.map(() => 0),
    ranks = components.map(() => 0);
  for (const edge of edges) {
    if (edge.issue || edge.source === null || edge.target === null) continue;
    const from = componentOf.get(edge.source),
      to = componentOf.get(edge.target);
    if (from === undefined || to === undefined) continue;
    if (from === to) {
      edge.cyclic = (components[from]?.length ?? 0) > 1 || edge.source === edge.target;
      if (edge.cyclic)
        for (const point of components[from] ?? []) {
          const node = nodes[point];
          if (node) node.cyclic = true;
        }
    } else if (!nextGroups[from]?.has(to)) {
      nextGroups[from]?.add(to);
      indegree[to] = (indegree[to] ?? 0) + 1;
    }
  }
  const first = (at: number) => components[at]?.[0] ?? 0,
    queue = components
      .flatMap((_, index) => (indegree[index] === 0 ? [index] : []))
      .sort((a, b) => first(a) - first(b));
  while (queue.length) {
    const at = queue.shift();
    if (at === undefined) break;
    for (const next of nextGroups[at] ?? []) {
      ranks[next] = Math.max(ranks[next] ?? 0, (ranks[at] ?? 0) + 1);
      indegree[next] = (indegree[next] ?? 0) - 1;
      if (indegree[next] === 0) {
        queue.push(next);
        queue.sort((a, b) => first(a) - first(b));
      }
    }
  }
  for (const node of nodes) node.rank = ranks[componentOf.get(node.index) ?? 0] ?? 0;
  const columns = new Map<number, MapNode[]>();
  for (const node of nodes) columns.set(node.rank, [...(columns.get(node.rank) ?? []), node]);
  const columnHeights = [...columns.values()].map(
      (column) =>
        column.reduce((height, node) => height + node.height, 0) +
        Math.max(0, column.length - 1) * ROW_GAP,
    ),
    contentHeight = Math.max(...columnHeights, 0);
  const longEdges = edges.filter(
      (edge) =>
        !edge.issue &&
        edge.source !== null &&
        edge.target !== null &&
        (nodes[edge.target]?.rank ?? 0) - (nodes[edge.source]?.rank ?? 0) > 1,
    ),
    lanes = new Map(longEdges.map((edge, index) => [edge.index, index % 8])),
    top = PADDING + Math.min(longEdges.length, 8) * 12;
  for (const [rank, column] of columns) {
    const height =
      column.reduce((sum, node) => sum + node.height, 0) + Math.max(0, column.length - 1) * ROW_GAP;
    let y = top + (contentHeight <= 520 ? (contentHeight - height) / 2 : 0);
    for (const node of column) {
      node.x = PADDING + rank * (WIDTH + GAP);
      node.y = y;
      y += node.height + ROW_GAP;
    }
  }
  for (const edge of edges) {
    if (edge.issue || edge.source === null || edge.target === null) continue;
    const from = nodes[edge.source],
      to = nodes[edge.target];
    if (!from || !to) continue;
    const x = from.x + from.width,
      y = from.y + from.height / 2,
      tx = to.x,
      ty = to.y + to.height / 2;
    if (edge.cyclic) {
      const loopX = x + 40 + (edge.index % 4) * 12;
      edge.path =
        edge.source === edge.target
          ? `M ${x} ${y - 18} C ${loopX} ${y - 54}, ${loopX} ${y + 54}, ${x} ${y + 18}`
          : `M ${x} ${y} C ${loopX} ${y}, ${loopX} ${ty}, ${to.x + to.width} ${ty}`;
    } else if (to.rank - from.rank > 1) {
      const lane = PADDING / 2 + (lanes.get(edge.index) ?? 0) * 12,
        sx = x + GAP / 3,
        ex = tx - GAP / 3;
      edge.path = `M ${x} ${y} H ${sx} V ${lane} H ${ex} V ${ty} H ${tx}`;
    } else {
      const middle = (x + tx) / 2;
      edge.path = `M ${x} ${y} C ${middle} ${y}, ${middle} ${ty}, ${tx} ${ty}`;
    }
  }
  return {
    nodes,
    edges,
    width: PADDING * 2 + (Math.max(...nodes.map((node) => node.rank)) + 1) * (WIDTH + GAP),
    height: top + contentHeight + PADDING,
    visual: true,
    oversized: false,
    hasCycles: nodes.some((node) => node.cyclic),
  };
}

export type ConnectionIdentity = { index: number; from: string; to: string };
/** Comparison only, never authority. Rebase a form only after the actual service returned this exact
 * isolated removal; an intervening/unknown edit keeps the older expected version and user entries. */
export function sameAfterOrphanRemoval(
  before: {
    id: string;
    version: number;
    name: string;
    classification: string;
    ownerMembershipId: string;
    graph: unknown;
  },
  after: {
    id: string;
    version: number;
    name: string;
    classification: string;
    ownerMembershipId: string;
    graph: unknown;
  },
  edge: ConnectionIdentity,
): boolean {
  if (
    before.id !== after.id ||
    after.version !== before.version + 1 ||
    before.name !== after.name ||
    before.classification !== after.classification ||
    before.ownerMembershipId !== after.ownerMembershipId
  )
    return false;
  const graph = record(before.graph),
    nodes = Array.isArray(graph.nodes) ? graph.nodes : [],
    edges = Array.isArray(graph.edges) ? graph.edges : [],
    selected = record(edges[edge.index]);
  if (
    !Number.isInteger(edge.index) ||
    edge.index < 0 ||
    selected.from !== edge.from ||
    selected.to !== edge.to ||
    nodes.some((raw) => {
      const node = record(raw);
      return node.id === edge.from || node.id === edge.to;
    })
  )
    return false;
  const expected = { ...graph, edges: edges.filter((_, index) => index !== edge.index) };
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
          .join(',') +
        '}'
      );
    return JSON.stringify(value) ?? 'undefined';
  };
  return stable(expected) === stable(after.graph);
}
