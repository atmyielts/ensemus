import { describe, expect, it } from 'vitest';
import type { ProcessGraph } from '@ensemus/domain/process-spec';
import {
  removeWorkflowConnection,
  applyWorkflowPoint,
  readWorkflowPoint,
} from '../../apps/web/src/lib/process-studio-input';
import { sameAfterOrphanRemoval } from '../../apps/web/src/lib/graph-layout';
const graph: ProcessGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
    { id: 'end', kind: 'end', label: 'Finish', x: 200, y: 0 },
  ],
  edges: [
    { from: 'gone', to: 'missing' },
    { from: 'start', to: 'end' },
    { from: 'start', to: 'end' },
    { from: 'also_missing', to: 'another_missing' },
  ],
};
const edge = { index: 0, from: 'gone', to: 'missing' },
  before = {
    id: 'generated',
    version: 3,
    name: 'Generated workflow',
    classification: 'internal',
    ownerMembershipId: 'generated-owner',
    graph,
  };
describe('exact saved orphan repair', () => {
  it('removes only that edge and preserves duplicate unrelated edges, every point and saved position', () => {
    const original = JSON.stringify(graph),
      saved = removeWorkflowConnection(graph, edge);
    expect(saved.nodes).toEqual(graph.nodes);
    expect(saved.edges).toEqual(graph.edges.slice(1));
    expect(JSON.stringify(graph)).toBe(original);
  });
  it('refuses stale index/from/to, an out-of-range index and removal of an ordinary point connection', () => {
    for (const value of [
      { ...edge, index: 9 },
      { ...edge, from: 'different' },
      { ...edge, to: 'different' },
      { index: 1, from: 'start', to: 'end' },
    ])
      expect(() => removeWorkflowConnection(graph, value)).toThrow();
  });
  it('allows advancing kept version only for the actually returned isolated removal', () => {
    const after = { ...before, version: 4, graph: removeWorkflowConnection(graph, edge) };
    expect(sameAfterOrphanRemoval(before, after, edge)).toBe(true);
    expect(sameAfterOrphanRemoval(before, { ...after, version: 5 }, edge)).toBe(false);
    expect(sameAfterOrphanRemoval(before, { ...after, name: 'Other saved name' }, edge)).toBe(
      false,
    );
    expect(sameAfterOrphanRemoval(before, { ...after, classification: 'restricted' }, edge)).toBe(
      false,
    );
    expect(sameAfterOrphanRemoval(before, { ...after, ownerMembershipId: 'other' }, edge)).toBe(
      false,
    );
  });
  it('retains the old version when any point or another edge changed concurrently', () => {
    const saved = removeWorkflowConnection(graph, edge);
    expect(
      sameAfterOrphanRemoval(
        before,
        {
          ...before,
          version: 4,
          graph: {
            ...saved,
            nodes: saved.nodes.map((node, index) =>
              index === 0 ? { ...node, label: 'Changed elsewhere' } : node,
            ),
          },
        },
        edge,
      ),
    ).toBe(false);
    expect(
      sameAfterOrphanRemoval(
        before,
        { ...before, version: 4, graph: { ...saved, edges: saved.edges.slice(1) } },
        edge,
      ),
    ).toBe(false);
  });
});

function pointChange(kind = 'work_item') {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    nodeId: 'repair',
    kind,
    label: 'Explicit replacement',
    previous: 'start',
    next: 'end',
  }))
    form.set(key, value);
  return readWorkflowPoint(form);
}
describe('explicit legacy point repair', () => {
  it('replaces only the chosen unknown kind before final validation and keeps unrelated repeated edges/order', () => {
    const legacy = {
        ...graph,
        nodes: [
          graph.nodes[0]!,
          { id: 'repair', kind: 'future_kind', label: 'Retained legacy choice', x: 73, y: 91 },
          graph.nodes[1]!,
        ],
        edges: [
          graph.edges[1]!,
          { from: 'repair', to: 'end' },
          graph.edges[1]!,
          { from: 'start', to: 'repair' },
          graph.edges[0]!,
        ],
      } as unknown as ProcessGraph,
      original = JSON.stringify(legacy),
      saved = applyWorkflowPoint(legacy, pointChange(), 'update');
    expect(saved.nodes.map((node) => node.id)).toEqual(['start', 'repair', 'end']);
    expect(saved.nodes[1]).toEqual({
      id: 'repair',
      kind: 'work_item',
      label: 'Explicit replacement',
      x: 73,
      y: 91,
    });
    expect(saved.nodes[0]).toEqual(legacy.nodes[0]);
    expect(saved.nodes[2]).toEqual(legacy.nodes[2]);
    expect(saved.edges).toEqual([
      graph.edges[1],
      graph.edges[1],
      graph.edges[0],
      { from: 'start', to: 'repair' },
      { from: 'repair', to: 'end' },
    ]);
    expect(JSON.stringify(legacy)).toBe(original);
  });
  it('can explicitly replace an unsupported selected approval/evidence rule instead of silently defaulting', () => {
    for (const extra of [
      { kind: 'human_approval', approverRole: 'future_reviewer' },
      { kind: 'evidence_check', evidence: 'future_evidence' },
    ]) {
      const legacy = {
        ...graph,
        nodes: [...graph.nodes, { id: 'repair', label: 'Legacy option', x: 10, y: 20, ...extra }],
      } as unknown as ProcessGraph;
      expect(applyWorkflowPoint(legacy, pointChange(), 'update').nodes.at(-1)).toMatchObject({
        kind: 'work_item',
        label: 'Explicit replacement',
      });
    }
  });
  it('refuses if another unsupported point remains and never changes the original to make it pass', () => {
    const legacy = {
        ...graph,
        nodes: [
          ...graph.nodes,
          { id: 'repair', kind: 'future_kind', label: 'Chosen legacy', x: 0, y: 0 },
          { id: 'other', kind: 'other_future_kind', label: 'Other retained choice', x: 0, y: 0 },
        ],
      } as unknown as ProcessGraph,
      original = JSON.stringify(legacy);
    expect(() => applyWorkflowPoint(legacy, pointChange(), 'update')).toThrow();
    expect(JSON.stringify(legacy)).toBe(original);
  });
});
