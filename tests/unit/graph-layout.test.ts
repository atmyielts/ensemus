import { describe, expect, it } from 'vitest';
import {
  layoutWorkflowGraph,
  mapLabelLines,
  workflowPointAnchor,
} from '../../apps/web/src/lib/graph-layout';
const point = (id: string, label = id, kind = 'work_item') => ({ id, label, kind, x: 10, y: 20 });
const fork = {
  nodes: [
    point('start', 'Start', 'start'),
    point('left', 'Gather evidence'),
    point('right', 'Check the request'),
    point('join', 'Review both results', 'human_approval'),
    point('end', 'Finish', 'end'),
  ],
  edges: [
    { from: 'start', to: 'left' },
    { from: 'start', to: 'right' },
    { from: 'left', to: 'join' },
    { from: 'right', to: 'join' },
    { from: 'join', to: 'end' },
  ],
};
describe('read-only saved workflow map', () => {
  it('retains every point and connection and lays out a real parallel fork and all-of join', () => {
    const map = layoutWorkflowGraph(fork);
    expect(map.nodes).toHaveLength(5);
    expect(map.edges).toHaveLength(5);
    expect(map.nodes.map((node) => node.rank)).toEqual([0, 1, 1, 2, 3]);
    expect(map.nodes[0]?.outgoing).toEqual([1, 2]);
    expect(map.nodes[3]?.incoming).toEqual([1, 2]);
    expect(map.edges.every((edge) => edge.path && edge.issue === null && !edge.cyclic)).toBe(true);
  });
  it('is deterministic and never writes new positions or changes a saved graph', () => {
    const before = JSON.stringify(fork),
      one = layoutWorkflowGraph(fork),
      two = layoutWorkflowGraph(fork);
    expect(one).toEqual(two);
    expect(JSON.stringify(fork)).toBe(before);
    const moved = { ...fork, nodes: fork.nodes.map((node) => ({ ...node, x: 999, y: -40 })) };
    expect(layoutWorkflowGraph(moved)).toEqual(one);
  });
  it('does not invent executable points for missing connection endpoints', () => {
    const map = layoutWorkflowGraph({
      nodes: [point('a')],
      edges: [
        { from: 'missing', to: 'a' },
        { from: 'gone', to: 'also-gone' },
      ],
    });
    expect(map.nodes).toHaveLength(1);
    expect(map.edges).toHaveLength(2);
    expect(map.edges.map((edge) => edge.issue)).toEqual(['missing', 'missing']);
    expect(map.edges.every((edge) => edge.path === '')).toBe(true);
    expect(map.nodes[0]?.unresolved).toBe(true);
  });
  it('keeps duplicate identities and different labels separate without choosing an ambiguous connection', () => {
    const map = layoutWorkflowGraph({
      nodes: [
        point('same', 'First saved label'),
        point('same', 'Second saved label'),
        point('other'),
      ],
      edges: [{ from: 'same', to: 'other' }],
    });
    expect(map.nodes.map((node) => node.label)).toEqual([
      'First saved label',
      'Second saved label',
      'other',
    ]);
    expect(
      map.nodes
        .slice(0, 2)
        .every((node) => node.duplicate && node.editTarget === workflowPointAnchor(0)),
    ).toBe(true);
    expect(map.edges[0]?.issue).toBe('ambiguous');
    expect(map.edges[0]?.path).toBe('');
  });
  it('shows cycles and self-connections as loops needing review, preserving their actual direction', () => {
    const map = layoutWorkflowGraph({
      nodes: [point('a'), point('b'), point('self')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'self', to: 'self' },
      ],
    });
    expect(map.hasCycles).toBe(true);
    expect(map.nodes.every((node) => node.cyclic)).toBe(true);
    expect(map.edges.every((edge) => edge.cyclic && edge.path.startsWith('M '))).toBe(true);
    expect(map.edges.map((edge) => [edge.source, edge.target])).toEqual([
      [0, 1],
      [1, 0],
      [2, 2],
    ]);
  });
  it('keeps unsupported saved kinds and repeated connections instead of reporting readiness', () => {
    const map = layoutWorkflowGraph({
      nodes: [point('future', 'Saved future point', 'future_kind'), point('b')],
      edges: [
        { from: 'future', to: 'b' },
        { from: 'future', to: 'b' },
      ],
    });
    expect(map.nodes[0]).toMatchObject({
      label: 'Saved future point',
      kind: 'future_kind',
      knownKind: false,
    });
    expect(map.edges).toHaveLength(2);
    expect(map.edges[1]?.repeated).toBe(true);
    expect(map).not.toHaveProperty('status');
  });
  it('keeps oversized saved content in the text model while refusing an unreadable picture', () => {
    const nodes = Array.from({ length: 65 }, (_, index) => point('node' + index)),
      edges = [{ from: 'node0', to: 'node64' }],
      map = layoutWorkflowGraph({ nodes, edges });
    expect(map.visual).toBe(false);
    expect(map.oversized).toBe(true);
    expect(map.nodes).toHaveLength(65);
    expect(map.edges).toHaveLength(1);
  });
  it('wraps the full text, including long words and Unicode, without clipping labels', () => {
    for (const label of [
      'A deliberately long work name with important final words',
      'W'.repeat(120),
      'Ҳисоботни текшириш ва тасдиқлаш',
      '검토할 자료와 다음 단계',
      '👩‍💻'.repeat(24),
    ])
      expect(mapLabelLines(label).join('').replaceAll(' ', '')).toBe(label.replace(/\s+/gu, ''));
  });
  it('keeps coordinates finite and forward dependencies ordered across bounded varied DAGs', () => {
    for (let count = 2; count < 24; count++) {
      const nodes = Array.from({ length: count }, (_, index) =>
          point(`point_${index}`, `Saved point ${index}`),
        ),
        edges = nodes.flatMap((_, to) =>
          nodes.flatMap((__, from) =>
            from < to && (from + to) % 3 === 0
              ? [{ from: `point_${from}`, to: `point_${to}` }]
              : [],
          ),
        ),
        map = layoutWorkflowGraph({ nodes, edges });
      expect(
        map.nodes.every((node) => [node.x, node.y, node.width, node.height].every(Number.isFinite)),
      ).toBe(true);
      for (const edge of map.edges) {
        if (edge.source === null || edge.target === null) throw new Error('TEST_EDGE_MISSING');
        expect(map.nodes[edge.source]?.rank).toBeLessThan(map.nodes[edge.target]?.rank ?? 0);
      }
      for (const left of map.nodes)
        for (const right of map.nodes)
          if (left.index < right.index && left.rank === right.rank)
            expect(left.y + left.height).toBeLessThanOrEqual(right.y);
    }
  });
});
