// AGENT-09, QA-035, QA-036, TR-032. The compiler is the main safety rule of the visual editor: what it lets
// through can run. The table holds each refusal, and the property tests hold the rule against a brute-force
// walk of every path in graphs nobody wrote by hand.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compileProcessGraph,
  PROCESS_LIMITS,
  verifyProcessSpec,
  type GraphIssue,
  type ProcessGraph,
  type ProcessGraphEdge,
  type ProcessGraphNode,
  type ProcessNodeKind,
  type ProcessSpec,
} from './process-spec';

const sha256 = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

const AGENT = '11111111-1111-4111-8111-111111111111';
const TOOL = 'email.send';

const context = (classification: ProcessSpec['classification'] = 'internal') => ({
  classification,
  agentDefinitionIds: new Set([AGENT]),
  toolIds: new Set([TOOL]),
});

/** A box with whatever its kind needs, so that a test only spells out what it is about. */
function node(
  id: string,
  kind: ProcessNodeKind,
  extra: Partial<ProcessGraphNode> = {},
): ProcessGraphNode {
  const settings: Partial<ProcessGraphNode> =
    kind === 'agent_task'
      ? { agentDefinitionId: AGENT }
      : kind === 'external_action'
        ? { toolId: TOOL }
        : kind === 'human_approval'
          ? { approverRole: 'process_owner' }
          : kind === 'evidence_check'
            ? { evidence: 'artifact_attached' }
            : {};
  return { id, kind, label: `Label of ${id}`, x: 0, y: 0, ...settings, ...extra };
}

const edge = (from: string, to: string): ProcessGraphEdge => ({ from, to });
const chain = (...ids: string[]) => ids.slice(1).map((id, index) => edge(ids[index]!, id));
const graph = (
  nodes: readonly ProcessGraphNode[],
  edges: readonly ProcessGraphEdge[],
): ProcessGraph => ({ schemaVersion: 1, nodes, edges });

const compile = (g: ProcessGraph, ctx = context()) => compileProcessGraph(g, ctx, sha256);

const SAFE = graph(
  [
    node('start', 'start'),
    node('prepare', 'work_item'),
    node('agent', 'agent_task'),
    node('approve', 'human_approval'),
    node('send', 'external_action'),
    node('check', 'evidence_check'),
    node('end', 'end'),
  ],
  chain('start', 'prepare', 'agent', 'approve', 'send', 'check', 'end'),
);

describe('a graph that can run', () => {
  it('compiles to steps with a hash, leaving out start and end', () => {
    const result = compile(SAFE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toEqual([]);
    expect(result.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.spec.classification).toBe('internal');
    expect(result.spec.steps.map((step) => step.key).sort()).toEqual(
      ['agent', 'approve', 'check', 'prepare', 'send'].sort(),
    );
    const byKey = new Map(result.spec.steps.map((step) => [step.key, step]));
    expect(byKey.get('prepare')?.after).toEqual([]);
    expect(byKey.get('send')).toEqual({
      key: 'send',
      kind: 'external_action',
      after: ['approve'],
      labelCode: null,
      label: 'Label of send',
      toolId: TOOL,
    });
    expect(byKey.get('agent')?.agentDefinitionId).toBe(AGENT);
    expect(byKey.get('approve')?.approverRole).toBe('process_owner');
    expect(byKey.get('check')?.evidence).toBe('artifact_attached');
  });

  it('accepts branches when every one of them passes an approval', () => {
    const result = compile(
      graph(
        [
          node('start', 'start'),
          node('a', 'human_approval'),
          node('b', 'human_approval'),
          node('send', 'external_action'),
          node('end', 'end'),
        ],
        [
          edge('start', 'a'),
          edge('start', 'b'),
          edge('a', 'send'),
          edge('b', 'send'),
          edge('send', 'end'),
        ],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('lets one approval cover what follows it, because the path has passed one', () => {
    const result = compile(
      graph(
        [
          node('start', 'start'),
          node('approve', 'human_approval'),
          node('first', 'external_action'),
          node('second', 'external_action'),
          node('end', 'end'),
        ],
        chain('start', 'approve', 'first', 'second', 'end'),
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('carries only the setting a kind uses, so a leftover cannot change what runs', () => {
    const plain = compile(
      graph([node('s', 'start'), node('w', 'work_item'), node('e', 'end')], chain('s', 'w', 'e')),
    );
    const leftover = compile(
      graph(
        [
          node('s', 'start'),
          node('w', 'work_item', { toolId: TOOL, agentDefinitionId: AGENT }),
          node('e', 'end'),
        ],
        chain('s', 'w', 'e'),
      ),
    );
    expect(plain.ok && leftover.ok).toBe(true);
    expect(leftover.specSha256).toBe(plain.specSha256);
  });

  it('treats a repeated connection as one', () => {
    const once = compile(SAFE);
    const twice = compile(graph(SAFE.nodes, [...SAFE.edges, edge('approve', 'send')]));
    expect(twice.specSha256).toBe(once.specSha256);
  });
});

// T0: every refusal, each pointing at the node it concerns.
const TABLE: readonly {
  name: string;
  graph: ProcessGraph;
  context?: ReturnType<typeof context>;
  expected: readonly GraphIssue[];
}[] = [
  {
    name: 'an effect with no approval',
    graph: graph(
      [node('s', 'start'), node('send', 'external_action'), node('e', 'end')],
      chain('s', 'send', 'e'),
    ),
    expected: [{ nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' }],
  },
  {
    name: 'an effect reached by a second path with no approval',
    graph: graph(
      [
        node('s', 'start'),
        node('approve', 'human_approval'),
        node('prepare', 'work_item'),
        node('send', 'external_action'),
        node('e', 'end'),
      ],
      [
        edge('s', 'approve'),
        edge('approve', 'send'),
        edge('s', 'prepare'),
        edge('prepare', 'send'),
        edge('send', 'e'),
      ],
    ),
    expected: [{ nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' }],
  },
  {
    name: 'an approval that only comes after the effect',
    graph: graph(
      [
        node('s', 'start'),
        node('send', 'external_action'),
        node('approve', 'human_approval'),
        node('e', 'end'),
      ],
      chain('s', 'send', 'approve', 'e'),
    ),
    expected: [{ nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' }],
  },
  {
    name: 'an approval on a parallel branch that the effect does not pass',
    graph: graph(
      [
        node('s', 'start'),
        node('approve', 'human_approval'),
        node('send', 'external_action'),
        node('e', 'end'),
      ],
      [edge('s', 'approve'), edge('s', 'send'), edge('approve', 'e'), edge('send', 'e')],
    ),
    expected: [{ nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' }],
  },
  {
    name: 'a second effect downstream of an unapproved first',
    graph: graph(
      [
        node('s', 'start'),
        node('one', 'external_action'),
        node('two', 'external_action'),
        node('e', 'end'),
      ],
      chain('s', 'one', 'two', 'e'),
    ),
    expected: [
      { nodeId: 'one', code: 'EFFECT_WITHOUT_APPROVAL' },
      { nodeId: 'two', code: 'EFFECT_WITHOUT_APPROVAL' },
    ],
  },
  {
    name: 'a cycle',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('b', 'work_item'), node('e', 'end')],
      [edge('s', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'e')],
    ),
    expected: [
      { nodeId: 'a', code: 'CYCLE' },
      { nodeId: 'b', code: 'CYCLE' },
    ],
  },
  {
    name: 'a self-edge',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('e', 'end')],
      [...chain('s', 'a', 'e'), edge('a', 'a')],
    ),
    expected: [{ nodeId: 'a', code: 'CYCLE' }],
  },
  {
    name: 'two starts',
    graph: graph(
      [node('s1', 'start'), node('s2', 'start'), node('a', 'work_item'), node('e', 'end')],
      [edge('s1', 'a'), edge('s2', 'a'), edge('a', 'e')],
    ),
    expected: [
      { nodeId: 's1', code: 'MANY_STARTS' },
      { nodeId: 's2', code: 'MANY_STARTS' },
    ],
  },
  {
    name: 'an effect reached from the second of two starts',
    graph: graph(
      [
        node('s1', 'start'),
        node('s2', 'start'),
        node('approve', 'human_approval'),
        node('send', 'external_action'),
        node('e', 'end'),
      ],
      [edge('s1', 'approve'), edge('approve', 'send'), edge('s2', 'send'), edge('send', 'e')],
    ),
    expected: [
      { nodeId: 's1', code: 'MANY_STARTS' },
      { nodeId: 's2', code: 'MANY_STARTS' },
      { nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' },
    ],
  },
  {
    name: 'no start',
    graph: graph([node('a', 'work_item'), node('e', 'end')], chain('a', 'e')),
    expected: [{ nodeId: null, code: 'NO_START' }],
  },
  {
    name: 'no end',
    graph: graph([node('s', 'start'), node('a', 'work_item')], chain('s', 'a')),
    expected: [{ nodeId: null, code: 'NO_END' }],
  },
  {
    name: 'a path that stops before the end',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('b', 'work_item'), node('e', 'end')],
      [edge('s', 'a'), edge('a', 'e'), edge('s', 'b')],
    ),
    expected: [{ nodeId: 'b', code: 'NO_END' }],
  },
  {
    name: 'an unreachable node',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('lost', 'work_item'), node('e', 'end')],
      [...chain('s', 'a', 'e'), edge('lost', 'e')],
    ),
    expected: [{ nodeId: 'lost', code: 'UNREACHABLE' }],
  },
  {
    name: 'a dangling edge, pointing at the node that is there',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('e', 'end')],
      [...chain('s', 'a', 'e'), edge('a', 'ghost')],
    ),
    expected: [{ nodeId: 'a', code: 'DANGLING_EDGE' }],
  },
  {
    name: 'a dangling edge from nowhere',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('e', 'end')],
      [...chain('s', 'a', 'e'), edge('ghost', 'a')],
    ),
    expected: [{ nodeId: 'a', code: 'DANGLING_EDGE' }],
  },
  {
    name: 'an edge leaving an end',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('e', 'end'), node('after', 'work_item')],
      [...chain('s', 'a', 'e'), edge('e', 'after'), edge('after', 'e')],
    ),
    expected: [
      { nodeId: 'after', code: 'CYCLE' },
      { nodeId: 'e', code: 'CYCLE' },
      { nodeId: 'e', code: 'DANGLING_EDGE' },
    ],
  },
  {
    name: 'a duplicate ID',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item'), node('a', 'external_action'), node('e', 'end')],
      chain('s', 'a', 'e'),
    ),
    // One of the two is an effect, so the ID counts as one, wherever it is listed.
    expected: [
      { nodeId: 'a', code: 'DUPLICATE_ID' },
      { nodeId: 'a', code: 'EFFECT_WITHOUT_APPROVAL' },
    ],
  },
  {
    name: 'a duplicate that poses as the approval an effect needed',
    graph: graph(
      [
        node('s', 'start'),
        node('gate', 'human_approval'),
        node('gate', 'work_item'),
        node('send', 'external_action'),
        node('e', 'end'),
      ],
      chain('s', 'gate', 'send', 'e'),
    ),
    expected: [
      { nodeId: 'gate', code: 'DUPLICATE_ID' },
      { nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' },
    ],
  },
  {
    name: 'too many nodes',
    graph: graph(
      Array.from({ length: PROCESS_LIMITS.maxNodes + 1 }, (_, i) => node(`n${i}`, 'work_item')),
      [],
    ),
    expected: [{ nodeId: null, code: 'TOO_LARGE' }],
  },
  {
    name: 'too many edges',
    graph: graph(
      [node('s', 'start'), node('e', 'end')],
      Array.from({ length: PROCESS_LIMITS.maxEdges + 1 }, () => edge('s', 'e')),
    ),
    expected: [{ nodeId: null, code: 'TOO_LARGE' }],
  },
  {
    name: 'a long label',
    graph: graph(
      [
        node('s', 'start'),
        node('a', 'work_item', { label: 'x'.repeat(PROCESS_LIMITS.maxLabelLength + 1) }),
        node('e', 'end'),
      ],
      chain('s', 'a', 'e'),
    ),
    expected: [{ nodeId: 'a', code: 'LABEL_TOO_LONG' }],
  },
  {
    name: 'an empty label on a step',
    graph: graph(
      [node('s', 'start'), node('a', 'work_item', { label: '   ' }), node('e', 'end')],
      chain('s', 'a', 'e'),
    ),
    expected: [{ nodeId: 'a', code: 'MISSING_SETTING' }],
  },
  {
    name: 'an unknown kind',
    graph: graph(
      [node('s', 'start'), node('a', 'send_money' as ProcessNodeKind), node('e', 'end')],
      chain('s', 'a', 'e'),
    ),
    expected: [{ nodeId: 'a', code: 'UNKNOWN_KIND' }],
  },
  {
    name: 'an unknown tool',
    graph: graph(
      [
        node('s', 'start'),
        node('approve', 'human_approval'),
        node('a', 'external_action', { toolId: 'wire.transfer' }),
        node('e', 'end'),
      ],
      chain('s', 'approve', 'a', 'e'),
    ),
    expected: [{ nodeId: 'a', code: 'UNKNOWN_TOOL' }],
  },
  {
    name: 'an unknown agent',
    graph: graph(
      [
        node('s', 'start'),
        node('a', 'agent_task', { agentDefinitionId: '22222222-2222-4222-8222-222222222222' }),
        node('e', 'end'),
      ],
      chain('s', 'a', 'e'),
    ),
    expected: [{ nodeId: 'a', code: 'UNKNOWN_AGENT' }],
  },
  {
    name: 'restricted work with an effect, even an approved one',
    graph: SAFE,
    context: context('restricted'),
    expected: [
      { nodeId: 'agent', code: 'RESTRICTED_EFFECT' },
      { nodeId: 'send', code: 'RESTRICTED_EFFECT' },
    ],
  },
  ...(
    [
      ['agent_task', 'agentDefinitionId'],
      ['external_action', 'toolId'],
      ['human_approval', 'approverRole'],
      ['evidence_check', 'evidence'],
    ] as const
  ).map(([kind, setting]) => {
    const incomplete = node('a', kind);
    delete incomplete[setting];
    return {
      name: `a ${kind} missing its setting`,
      graph: graph(
        [
          node('s', 'start'),
          node('approve', 'human_approval'),
          // Removed rather than left undefined, as a stored graph would be.
          incomplete,
          node('e', 'end'),
        ],
        chain('s', 'approve', 'a', 'e'),
      ),
      expected: [{ nodeId: 'a', code: 'MISSING_SETTING' as const }],
    };
  }),
  {
    name: 'a setting outside the choices on offer',
    graph: graph(
      [
        node('s', 'start'),
        node('a', 'human_approval', { approverRole: 'anyone' as 'process_owner' }),
        node('e', 'end'),
      ],
      chain('s', 'a', 'e'),
    ),
    expected: [{ nodeId: 'a', code: 'MISSING_SETTING' }],
  },
  {
    name: 'a workflow with nothing in it',
    graph: graph([node('s', 'start'), node('e', 'end')], chain('s', 'e')),
    expected: [{ nodeId: null, code: 'MISSING_SETTING' }],
  },
  {
    name: "an ID that could carry a person's text into a log",
    graph: graph(
      [node('s', 'start'), node('my secret plan', 'work_item'), node('e', 'end')],
      chain('s', 'my secret plan', 'e'),
    ),
    expected: [{ nodeId: 'my secret plan', code: 'MISSING_SETTING' }],
  },
];

describe('a graph that cannot run', () => {
  it.each(TABLE)('refuses $name', ({ graph: g, context: ctx, expected }) => {
    const result = compile(g, ctx ?? context());
    expect(result.ok).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.specSha256).toBeNull();
    expect(result.issues).toEqual(expected);
  });

  it('never repairs: it reports every issue at once', () => {
    const result = compile(
      graph(
        [
          node('s1', 'start'),
          node('s2', 'start'),
          node('send', 'external_action', { toolId: 'nope' }),
          node('loop', 'work_item'),
          node('lost', 'work_item'),
        ],
        [edge('s1', 'send'), edge('s2', 'loop'), edge('loop', 'loop'), edge('send', 'ghost')],
      ),
    );
    const codes = result.issues.map((issue) => issue.code);
    for (const code of [
      'MANY_STARTS',
      'NO_END',
      'UNKNOWN_TOOL',
      'EFFECT_WITHOUT_APPROVAL',
      'CYCLE',
      'UNREACHABLE',
      'DANGLING_EDGE',
    ]) {
      expect(codes).toContain(code);
    }
  });

  it('survives what a stored graph could hold, without throwing', () => {
    const odd: unknown[] = [
      null,
      undefined,
      {},
      { schemaVersion: 2, nodes: [], edges: [] },
      { schemaVersion: 1, nodes: 'nope', edges: 7 },
      { schemaVersion: 1, nodes: [null, 4, 'x', {}], edges: [null, {}, { from: 1, to: 2 }] },
      {
        schemaVersion: 1,
        nodes: [
          { id: '__proto__', kind: 'start', label: 'a' },
          { id: 'constructor', kind: 'end', label: 'b' },
        ],
        edges: [{ from: '__proto__', to: 'constructor' }],
      },
    ];
    for (const value of odd) {
      const result = compile(value as ProcessGraph);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('handles a deep chain, at the limit, without running out of stack', () => {
    const ids = Array.from({ length: PROCESS_LIMITS.maxNodes - 2 }, (_, i) => `n${i}`);
    const result = compile(
      graph(
        [node('s', 'start'), ...ids.map((id) => node(id, 'work_item')), node('e', 'end')],
        chain('s', ...ids, 'e'),
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe("the label is a person's text", () => {
  it('stays on the step, for the page, and out of keys and issues', () => {
    const canary = 'CANARY-do-not-repeat';
    const good = compile(
      graph(
        [node('s', 'start'), node('a', 'work_item', { label: canary }), node('e', 'end')],
        chain('s', 'a', 'e'),
      ),
    );
    if (!good.ok) throw new Error('should compile');
    expect(good.spec.steps[0]?.label).toBe(canary);
    expect(good.spec.steps[0]?.key).toBe('a');

    const bad = compile(
      graph([node('s', 'start'), node('a', 'external_action', { label: canary })], chain('s', 'a')),
    );
    expect(JSON.stringify(bad.issues)).not.toContain(canary);
  });

  it('changes the hash, because a reviewer read it', () => {
    const renamed = compile(
      graph(
        SAFE.nodes.map((n) => (n.id === 'send' ? { ...n, label: 'Something else' } : n)),
        SAFE.edges,
      ),
    );
    expect(renamed.specSha256).not.toBe(compile(SAFE).specSha256);
  });
});

/** A small generator with a seed, so a failure can be run again. No new dependency for this. */
function randomFrom(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  const int = (max: number) => Math.floor(next() * max);
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { next, int, shuffle };
}

const MIDDLE_KINDS: readonly ProcessNodeKind[] = [
  'work_item',
  'agent_task',
  'human_approval',
  'external_action',
  'evidence_check',
];

/** A graph drawn left to right, so it has no cycle, with every step reachable and reaching the end. */
function randomDag(seed: number): ProcessGraph {
  const random = randomFrom(seed);
  const count = 1 + random.int(10);
  const middle = Array.from({ length: count }, (_, i) =>
    node(`m${i}`, MIDDLE_KINDS[random.int(MIDDLE_KINDS.length)]!),
  );
  const ordered = [node('start', 'start'), ...middle, node('end', 'end')];
  const edges: ProcessGraphEdge[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    edges.push(edge(ordered[random.int(i)]!.id, ordered[i]!.id));
  }
  for (let i = 0; i < ordered.length - 1; i += 1) {
    if (i === 0 || random.next() < 0.3) {
      edges.push(edge(ordered[i]!.id, ordered[i + 1 + random.int(ordered.length - i - 1)]!.id));
    }
  }
  // Anything left with no way forward goes on to the end, so only the approval rule can refuse this.
  for (const item of middle) {
    if (!edges.some((e) => e.from === item.id)) edges.push(edge(item.id, 'end'));
  }
  return graph(ordered, edges);
}

/** The rule itself, the slow way: walk every path from the start and look at each one. */
function bruteForceUnapproved(g: ProcessGraph): string[] {
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const found = new Set<string>();
  const walk = (id: string, approved: boolean) => {
    const kind = kindOf.get(id);
    if (kind === 'external_action' && !approved) found.add(id);
    const passed = approved || kind === 'human_approval';
    for (const e of g.edges) if (e.from === id) walk(e.to, passed);
  };
  walk('start', false);
  return [...found].sort();
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i * 7919 + 1);

describe('properties over generated graphs', () => {
  it('flags an effect exactly when some path reaches it with no approval', () => {
    let refused = 0;
    let passed = 0;
    for (const seed of SEEDS) {
      const g = randomDag(seed);
      const flagged = compile(g)
        .issues.filter((issue) => issue.code === 'EFFECT_WITHOUT_APPROVAL')
        .map((issue) => issue.nodeId)
        .sort();
      expect(flagged, `seed ${seed}`).toEqual(bruteForceUnapproved(g));
      if (flagged.length) refused += 1;
      else passed += 1;
    }
    // The property means nothing unless the generator reaches both sides of it.
    expect(refused).toBeGreaterThan(20);
    expect(passed).toBeGreaterThan(20);
  });

  it('gives the same answer wherever the boxes are and in whatever order they are listed', () => {
    for (const seed of SEEDS) {
      const g = randomDag(seed);
      const random = randomFrom(seed ^ 0x5bd1e995);
      const moved = graph(
        random
          .shuffle(g.nodes)
          .map((n) => ({ ...n, x: random.next() * 9000, y: -random.next() * 9000 })),
        random.shuffle(g.edges),
      );
      const before = compile(g);
      const after = compile(moved);
      expect(after.specSha256, `seed ${seed}`).toBe(before.specSha256);
      expect(after.spec, `seed ${seed}`).toEqual(before.spec);
      expect(after.issues, `seed ${seed}`).toEqual(before.issues);
    }
  });

  it('gives the same answer every time', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      expect(compile(randomDag(seed))).toEqual(compile(randomDag(seed)));
    }
  });

  it('only ever lets through a spec that passes the check made again at publishing', () => {
    let compiled = 0;
    for (const seed of SEEDS) {
      const result = compile(randomDag(seed));
      if (!result.ok) continue;
      compiled += 1;
      expect(verifyProcessSpec(result.spec), `seed ${seed}`).toEqual([]);
    }
    expect(compiled).toBeGreaterThan(20);
  });

  it('never throws on a graph with random damage', () => {
    for (const seed of SEEDS) {
      const random = randomFrom(seed);
      const g = randomDag(seed);
      const damaged = graph(
        g.nodes.filter(() => random.next() > 0.2),
        [...g.edges, edge(`m${random.int(12)}`, `m${random.int(12)}`)].filter(
          () => random.next() > 0.2,
        ),
      );
      const result = compile(damaged);
      expect(result.ok ? result.issues.length === 0 : result.issues.length > 0).toBe(true);
    }
  });
});

describe('position and order', () => {
  it('moved boxes keep the hash', () => {
    const moved = graph(
      SAFE.nodes.map((n, i) => ({ ...n, x: 1000 + i * 37, y: -500 - i })),
      SAFE.edges,
    );
    expect(compile(moved).specSha256).toBe(compile(SAFE).specSha256);
  });

  it('reordered nodes and edges keep the hash', () => {
    const reordered = graph([...SAFE.nodes].reverse(), [...SAFE.edges].reverse());
    expect(compile(reordered).specSha256).toBe(compile(SAFE).specSha256);
  });

  it('a changed classification changes the hash', () => {
    expect(compile(SAFE, context('confidential')).specSha256).not.toBe(compile(SAFE).specSha256);
  });

  it('a changed connection changes the hash', () => {
    const changed = compile(graph(SAFE.nodes, [...SAFE.edges, edge('prepare', 'approve')]));
    expect(changed.ok).toBe(true);
    expect(changed.specSha256).not.toBe(compile(SAFE).specSha256);
  });
});

describe('the check made again at publishing', () => {
  const step = (
    key: string,
    kind: ProcessSpec['steps'][number]['kind'],
    after: string[],
  ): ProcessSpec['steps'][number] => ({ key, kind, after, labelCode: null, label: key });
  const spec = (
    steps: ProcessSpec['steps'],
    classification: ProcessSpec['classification'] = 'internal',
  ): ProcessSpec => ({ schemaVersion: 1, classification, steps });

  it('refuses an effect with no approval before it, whatever a caller wrote by hand', () => {
    expect(verifyProcessSpec(spec([step('send', 'external_action', [])]))).toEqual([
      { nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' },
    ]);
  });

  it('refuses an effect with an approval on only one of its ways in', () => {
    expect(
      verifyProcessSpec(
        spec([
          step('a', 'human_approval', []),
          step('b', 'work_item', []),
          step('send', 'external_action', ['a', 'b']),
        ]),
      ),
    ).toEqual([{ nodeId: 'send', code: 'EFFECT_WITHOUT_APPROVAL' }]);
  });

  it('refuses a loop, a repeated key and a step that follows nothing there', () => {
    const codes = verifyProcessSpec(
      spec([
        step('a', 'work_item', ['b']),
        step('b', 'work_item', ['a']),
        step('c', 'work_item', ['ghost']),
        step('c', 'work_item', []),
      ]),
    ).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['CYCLE', 'DANGLING_EDGE', 'DUPLICATE_ID']));
  });

  it('refuses an effect in restricted work', () => {
    expect(
      verifyProcessSpec(
        spec(
          [step('a', 'human_approval', []), step('send', 'external_action', ['a'])],
          'restricted',
        ),
      ),
    ).toEqual([{ nodeId: 'send', code: 'RESTRICTED_EFFECT' }]);
  });

  it('accepts an effect behind an approval', () => {
    expect(
      verifyProcessSpec(
        spec([step('a', 'human_approval', []), step('send', 'external_action', ['a'])]),
      ),
    ).toEqual([]);
  });
});
