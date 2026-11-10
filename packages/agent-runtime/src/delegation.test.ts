// ADR-028 FD-16, QA-013, FAULT-09, threats SEC-007 and SEC-010. The rules for what a child may have, with
// no database. A union here instead of an intersection is an escalation, and recursion spends real money,
// so the money cases run a whole tree in memory and add it up.
import { agentDelegateArgsSchema } from '@ensemus/contracts/ai-tools';
import {
  CLASSIFICATIONS,
  strongestClassification,
  type AiClassification,
} from '@ensemus/domain/ai';
import { describe, expect, it } from 'vitest';
import {
  allowedDepth,
  allowedFanOut,
  carveChildBudget,
  childHoldMicros,
  decideDelegation,
  intersectScopes,
  NO_DELEGATION,
  readOrgDelegationLimits,
  remainingForChildren,
  type DelegationInput,
} from './delegation';

const limits = {
  maxModelTurns: 10,
  maxToolCalls: 20,
  maxTotalTokens: 10_000,
  maxCostMicros: 1_000,
  timeoutSeconds: 600,
  maxDelegationDepth: 2,
};

const input = (over: Partial<DelegationInput> = {}): DelegationInput => ({
  parent: {
    depth: 0,
    tools: ['work.read', 'artifact.read_text', 'agent.delegate'],
    classification: 'internal',
    limits,
    costMicros: 0,
    boundToProfile: true,
  },
  workClassification: 'internal',
  liveChildren: 0,
  childHolds: [],
  org: { maxDepth: 5, maxFanOut: 5 },
  asked: { tools: ['work.read'], maxCostMicros: 100 },
  childManifest: {
    allow: ['work.read', 'artifact.read_text', 'agent.delegate'],
    deny: [],
    limits: { ...limits, maxCostMicros: 1_000_000 },
  },
  ...over,
});

const denied = (code: string, reason = code) => ({ kind: 'denied', code, reason });

describe('intersectScopes', () => {
  it('grants only what the parent holds and was asked for', () => {
    expect(intersectScopes(['a', 'b', 'c'], ['b', 'c'])).toEqual({
      granted: ['b', 'c'],
      refused: [],
    });
  });

  it('is an intersection and never a union', () => {
    const { granted, refused } = intersectScopes(['a', 'b'], ['b', 'x']);
    expect(granted).toEqual(['b']);
    expect(refused).toEqual(['x']);
    // What the parent holds and nobody asked for does not come along either.
    expect(granted).not.toContain('a');
  });

  it('never grants anything the parent lacks, whatever the two lists are', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const subset = (bits: number) => names.filter((_, i) => bits & (1 << i));
    for (let p = 0; p < 32; p += 1) {
      for (let q = 0; q < 32; q += 1) {
        const parent = subset(p);
        const asked = subset(q);
        const { granted, refused } = intersectScopes(parent, asked);
        for (const tool of granted) {
          expect(parent).toContain(tool);
          expect(asked).toContain(tool);
        }
        expect([...granted, ...refused].sort()).toEqual([...asked].sort());
        for (const tool of refused) expect(parent).not.toContain(tool);
      }
    }
  });

  it('gives nothing to a parent with nothing, and nothing to a child that asks for nothing', () => {
    expect(intersectScopes([], ['a'])).toEqual({ granted: [], refused: ['a'] });
    expect(intersectScopes(['a'], [])).toEqual({ granted: [], refused: [] });
  });

  it('matches exactly: a near miss, a capital or a wildcard is not the same tool', () => {
    for (const asked of ['WORK.READ', 'work.read ', 'work.*', '*', '__proto__', 'constructor']) {
      expect(intersectScopes(['work.read'], [asked])).toEqual({ granted: [], refused: [asked] });
    }
  });

  it('counts a repeated name once', () => {
    expect(intersectScopes(['a'], ['a', 'a', 'x', 'x'])).toEqual({
      granted: ['a'],
      refused: ['x'],
    });
  });
});

describe('allowedDepth and allowedFanOut', () => {
  it.each([
    [3, 1, 1],
    [1, 3, 1],
    [2, 2, 2],
    [0, 5, 0],
    [5, 0, 0],
  ])('takes the lower of %i and %i', (manifest, org, expected) => {
    expect(allowedDepth(manifest, org)).toBe(expected);
    expect(allowedFanOut(manifest, org)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_VALUE])(
    'reads %d as no permission rather than a large one',
    (bad) => {
      expect(allowedDepth(bad, 5)).toBe(0);
      expect(allowedDepth(5, bad)).toBe(0);
      expect(allowedFanOut(bad, 5)).toBe(0);
      expect(allowedFanOut(5, bad)).toBe(0);
    },
  );
});

describe('readOrgDelegationLimits', () => {
  it('means no delegation when there is no active bundle', () => {
    expect(readOrgDelegationLimits(null)).toEqual(NO_DELEGATION);
    expect(NO_DELEGATION).toEqual({ maxDepth: 0, maxFanOut: 0 });
  });

  const bundle = (agentLimits: unknown) => ({
    organization_policy: { agent_limits: agentLimits },
  });

  it('reads the two limits from a bundle', () => {
    expect(
      readOrgDelegationLimits(bundle({ max_delegation_depth: 2, max_delegation_fan_out: 3 })),
    ).toEqual({ maxDepth: 2, maxFanOut: 3 });
  });

  it('reads the shape of the example policy, which has a limit on live runs and no fan-out', () => {
    expect(
      readOrgDelegationLimits(
        bundle({
          max_concurrent_runs_per_org: 15,
          max_delegation_depth: 2,
          tool_actions_recheck_policy: true,
        }),
      ),
    ).toEqual({ maxDepth: 2, maxFanOut: 15 });
  });

  it('takes the fan-out over the limit on live runs, even when the fan-out is lower', () => {
    expect(
      readOrgDelegationLimits(
        bundle({
          max_concurrent_runs_per_org: 15,
          max_delegation_depth: 2,
          max_delegation_fan_out: 1,
        }),
      ),
    ).toEqual({ maxDepth: 2, maxFanOut: 1 });
  });

  it.each([
    [{}],
    ['text'],
    [7],
    [[]],
    [{ organization_policy: null }],
    [{ organization_policy: [] }],
    [{ organization_policy: {} }],
    [bundle(null)],
    [bundle([])],
    [bundle({ max_delegation_depth: '9', max_delegation_fan_out: '9' })],
    [bundle({ max_delegation_depth: -1, max_delegation_fan_out: 1.5 })],
    [bundle({ max_delegation_depth: 1e308, max_delegation_fan_out: 1e308 })],
    // Keys another reader might have assumed. Nothing here is read but what the policy file names.
    [{ agentLimits: { maxDelegationDepth: 5, maxDelegationFanOut: 5 } }],
    [{ agent_limits: { max_delegation_depth: 5, max_delegation_fan_out: 5 } }],
  ])('fails closed on a bundle it cannot read: %j', (document) => {
    expect(readOrgDelegationLimits(document)).toEqual(NO_DELEGATION);
  });

  it('holds each limit separately, and a missing one is zero rather than a default', () => {
    expect(readOrgDelegationLimits(bundle({ max_delegation_depth: 2 }))).toEqual({
      maxDepth: 2,
      maxFanOut: 0,
    });
    expect(readOrgDelegationLimits(bundle({ max_delegation_fan_out: 2 }))).toEqual({
      maxDepth: 0,
      maxFanOut: 2,
    });
  });

  it('does not fall back to the limit on live runs when a fan-out was written and is unreadable', () => {
    expect(
      readOrgDelegationLimits(
        bundle({
          max_concurrent_runs_per_org: 15,
          max_delegation_depth: 2,
          max_delegation_fan_out: 'many',
        }),
      ),
    ).toEqual({ maxDepth: 2, maxFanOut: 0 });
  });
});

describe('carveChildBudget', () => {
  it('gives what was asked when that much is left', () => {
    expect(carveChildBudget(100, 40)).toEqual({ ok: true, micros: 40 });
    expect(carveChildBudget(100, 100)).toEqual({ ok: true, micros: 100 });
  });

  it('refuses more than is left, and never trims it to fit', () => {
    expect(carveChildBudget(100, 101)).toEqual({ ok: false });
  });

  it('refuses when nothing is left', () => {
    expect(carveChildBudget(0, 1)).toEqual({ ok: false });
    expect(carveChildBudget(-5, 1)).toEqual({ ok: false });
  });

  it('refuses a child with no money, so recursion cannot go on for free', () => {
    expect(carveChildBudget(100, 0)).toEqual({ ok: false });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %d, whichever side it is on',
    (bad) => {
      expect(carveChildBudget(100, bad)).toEqual({ ok: false });
      expect(carveChildBudget(bad, 1)).toEqual({ ok: false });
    },
  );
});

describe('remainingForChildren', () => {
  it('takes off what the run spent and what its children hold', () => {
    expect(
      remainingForChildren({ maxCostMicros: 1_000, costMicros: 100, childHolds: [200, 300] }),
    ).toBe(400);
  });

  it('is never below zero, even when a settled call overspent', () => {
    expect(remainingForChildren({ maxCostMicros: 100, costMicros: 500, childHolds: [] })).toBe(0);
    expect(remainingForChildren({ maxCostMicros: 100, costMicros: 50, childHolds: [80] })).toBe(0);
  });

  it('reads a number it cannot trust as nothing left', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(remainingForChildren({ maxCostMicros: bad, costMicros: 0, childHolds: [] })).toBe(0);
      expect(remainingForChildren({ maxCostMicros: 100, costMicros: bad, childHolds: [] })).toBe(0);
      expect(remainingForChildren({ maxCostMicros: 100, costMicros: 0, childHolds: [bad] })).toBe(
        0,
      );
    }
  });
});

describe('childHoldMicros', () => {
  it('holds a live child at its whole limit, and more if it has already overspent', () => {
    expect(childHoldMicros({ maxCostMicros: 100, costMicros: 0 })).toBe(100);
    expect(childHoldMicros({ maxCostMicros: 100, costMicros: 150 })).toBe(150);
  });
});

describe('decideDelegation', () => {
  it('grants the intersection, with limits no higher than the parent has', () => {
    const decision = decideDelegation(input());
    expect(decision).toMatchObject({
      kind: 'allowed',
      tools: ['work.read'],
      maxCostMicros: 100,
      classification: 'internal',
    });
  });

  describe('scopes', () => {
    it('denies a child asking for a tool the parent does not hold (QA-013)', () => {
      expect(
        decideDelegation(input({ asked: { tools: ['email.send'], maxCostMicros: 100 } })),
      ).toEqual(denied('DELEGATION_WIDENED'));
    });

    it('denies the whole request when any one tool is more than the parent holds', () => {
      expect(
        decideDelegation(
          input({ asked: { tools: ['work.read', 'email.send'], maxCostMicros: 100 } }),
        ),
      ).toEqual(denied('DELEGATION_WIDENED'));
    });

    it('does not give the child a tool its own manifest leaves out', () => {
      const decision = decideDelegation(
        input({
          asked: { tools: ['work.read', 'artifact.read_text'], maxCostMicros: 100 },
          childManifest: { ...input().childManifest, allow: ['work.read'] },
        }),
      );
      expect(decision).toMatchObject({ kind: 'allowed', tools: ['work.read'] });
    });

    it("lets the child manifest's deny win", () => {
      const decision = decideDelegation(
        input({
          asked: { tools: ['work.read', 'artifact.read_text'], maxCostMicros: 100 },
          childManifest: { ...input().childManifest, deny: ['artifact.read_text'] },
        }),
      );
      expect(decision).toMatchObject({ kind: 'allowed', tools: ['work.read'] });
    });

    it('can only shrink along a chain, however long', () => {
      let held = ['work.read', 'artifact.read_text', 'agent.delegate'];
      for (const asked of [
        ['work.read', 'agent.delegate'],
        ['agent.delegate'],
        [],
      ] as readonly string[][]) {
        const decision = decideDelegation(
          input({
            parent: { ...input().parent, tools: held },
            asked: { tools: asked, maxCostMicros: 1 },
          }),
        );
        if (decision.kind !== 'allowed') throw new Error('Expected a child');
        for (const tool of decision.tools) expect(held).toContain(tool);
        held = [...decision.tools];
      }
      expect(held).toEqual([]);
    });
  });

  describe('depth', () => {
    it('stops an agent whose manifest gives a depth of 0, whatever the organization allows', () => {
      expect(
        decideDelegation(
          input({ parent: { ...input().parent, limits: { ...limits, maxDelegationDepth: 0 } } }),
        ),
      ).toEqual(denied('DELEGATION_DEPTH'));
    });

    it('stops everything when no bundle gives a depth', () => {
      expect(decideDelegation(input({ org: NO_DELEGATION }))).toEqual(denied('DELEGATION_DEPTH'));
    });

    it('counts the organization limit from the top of the tree', () => {
      const org = { maxDepth: 2, maxFanOut: 5 };
      const atDepth = (depth: number) =>
        decideDelegation(
          input({
            org,
            parent: { ...input().parent, depth, limits: { ...limits, maxDelegationDepth: 5 } },
          }),
        );
      expect(atDepth(0).kind).toBe('allowed');
      expect(atDepth(1).kind).toBe('allowed');
      expect(atDepth(2)).toEqual(denied('DELEGATION_DEPTH'));
      expect(atDepth(3)).toEqual(denied('DELEGATION_DEPTH'));
    });

    it('gives the child the lowest of what the parent has left, its manifest and the org', () => {
      const childDepth = (parentDepthLimit: number, manifest: number, org: number, depth = 0) => {
        const decision = decideDelegation(
          input({
            org: { maxDepth: org, maxFanOut: 5 },
            parent: {
              ...input().parent,
              depth,
              limits: { ...limits, maxDelegationDepth: parentDepthLimit },
            },
            childManifest: {
              ...input().childManifest,
              limits: { ...input().childManifest.limits, maxDelegationDepth: manifest },
            },
          }),
        );
        if (decision.kind !== 'allowed') throw new Error('Expected a child');
        return decision.limits.maxDelegationDepth;
      };
      expect(childDepth(3, 5, 5)).toBe(2);
      expect(childDepth(5, 1, 5)).toBe(1);
      expect(childDepth(5, 5, 2)).toBe(1);
      expect(childDepth(5, 5, 3, 1)).toBe(1);
      expect(childDepth(1, 5, 5)).toBe(0);
    });

    it('cannot go on for ever: a chain ends within the lower limit', () => {
      for (const [manifest, org] of [
        [1, 5],
        [5, 1],
        [3, 3],
      ] as const) {
        let parent: DelegationInput['parent'] = {
          ...input().parent,
          limits: { ...limits, maxDelegationDepth: manifest },
        };
        let levels = 0;
        for (;;) {
          const decision = decideDelegation(
            input({ parent, org: { maxDepth: org, maxFanOut: 5 } }),
          );
          if (decision.kind !== 'allowed') {
            expect(decision.code).toBe('DELEGATION_DEPTH');
            break;
          }
          levels += 1;
          expect(levels).toBeLessThanOrEqual(Math.min(manifest, org));
          parent = {
            ...parent,
            depth: parent.depth + 1,
            limits: { ...parent.limits, maxDelegationDepth: decision.limits.maxDelegationDepth },
          };
        }
        expect(levels).toBe(Math.min(manifest, org));
      }
    });
  });

  describe('fan-out', () => {
    it('holds at the organization limit when that is lower', () => {
      const org = { maxDepth: 5, maxFanOut: 2 };
      expect(decideDelegation(input({ org, liveChildren: 1 })).kind).toBe('allowed');
      expect(decideDelegation(input({ org, liveChildren: 2 }))).toEqual(
        denied('DELEGATION_FANOUT'),
      );
    });

    it("holds at the manifest's tool calls when those are lower", () => {
      const parent = { ...input().parent, limits: { ...limits, maxToolCalls: 1 } };
      expect(decideDelegation(input({ parent, liveChildren: 0 })).kind).toBe('allowed');
      expect(decideDelegation(input({ parent, liveChildren: 1 }))).toEqual(
        denied('DELEGATION_FANOUT'),
      );
    });

    it('denies when the bundle sets a depth and no fan-out', () => {
      expect(decideDelegation(input({ org: { maxDepth: 5, maxFanOut: 0 } }))).toEqual(
        denied('DELEGATION_FANOUT'),
      );
    });
  });

  describe('money', () => {
    it('takes what the parent spent and what live children hold', () => {
      const parent = { ...input().parent, costMicros: 300 };
      const childHolds = [{ maxCostMicros: 600, costMicros: 10 }];
      expect(
        decideDelegation(input({ parent, childHolds, asked: { tools: [], maxCostMicros: 100 } })),
      ).toMatchObject({ kind: 'allowed', maxCostMicros: 100 });
      expect(
        decideDelegation(input({ parent, childHolds, asked: { tools: [], maxCostMicros: 101 } })),
      ).toEqual(denied('BUDGET_EXHAUSTED'));
    });

    it('never gives a child more than its own manifest allows', () => {
      const decision = decideDelegation(
        input({
          asked: { tools: [], maxCostMicros: 900 },
          childManifest: {
            ...input().childManifest,
            limits: { ...input().childManifest.limits, maxCostMicros: 50 },
          },
        }),
      );
      expect(decision).toMatchObject({ kind: 'allowed', maxCostMicros: 50 });
    });

    it('refuses when a manifest allows no money at all', () => {
      expect(
        decideDelegation(
          input({
            childManifest: {
              ...input().childManifest,
              limits: { ...input().childManifest.limits, maxCostMicros: 0 },
            },
          }),
        ),
      ).toEqual(denied('BUDGET_EXHAUSTED'));
    });

    it('gives back what a finished child did not use, and only that (FAULT-09)', () => {
      const ceiling = 1_000;
      let parentCost = 0;
      const first = carveChildBudget(
        remainingForChildren({ maxCostMicros: ceiling, costMicros: parentCost, childHolds: [] }),
        800,
      );
      expect(first).toEqual({ ok: true, micros: 800 });
      // While it runs, the whole 800 is held.
      expect(
        remainingForChildren({ maxCostMicros: ceiling, costMicros: parentCost, childHolds: [800] }),
      ).toBe(200);
      // It finished having used 300. That is now the parent's cost, and the other 500 is free again.
      parentCost += 300;
      expect(
        remainingForChildren({ maxCostMicros: ceiling, costMicros: parentCost, childHolds: [] }),
      ).toBe(700);
    });
  });

  describe('a recursive script (SEC-010)', () => {
    type Node = {
      depth: number;
      maxCostMicros: number;
      costMicros: number;
      maxDelegationDepth: number;
      children: Node[];
    };

    const total = (node: Node): number =>
      node.children.reduce((sum, child) => sum + total(child), node.costMicros);

    /**
     * Every run spends what its step costs and then tries for as many children as it is allowed, each
     * asking for `ask`, as an obedient model following a poisoned document would. Children run to the
     * end, the way a join does, so what they did not use is free again.
     */
    function run(
      node: Node,
      script: { ask: number; spend: number; org: { maxDepth: number; maxFanOut: number } },
      codes: string[],
    ): void {
      node.costMicros = Math.min(node.maxCostMicros, script.spend);
      // Model the reducer's independent tool-call limit too: settled children release money and
      // fan-out, but each sequential delegation still consumes a tool call (AGENT-02).
      const maxToolCalls = 1_000;
      for (let i = 0; i < maxToolCalls; i += 1) {
        const decision = decideDelegation({
          ...input(),
          parent: {
            depth: node.depth,
            tools: ['agent.delegate'],
            classification: 'internal',
            costMicros: node.costMicros + node.children.reduce((sum, c) => sum + total(c), 0),
            boundToProfile: true,
            limits: {
              ...limits,
              maxToolCalls,
              maxCostMicros: node.maxCostMicros,
              maxDelegationDepth: node.maxDelegationDepth,
            },
          },
          org: script.org,
          asked: { tools: ['agent.delegate'], maxCostMicros: script.ask },
          childManifest: {
            allow: ['agent.delegate'],
            deny: [],
            limits: { ...limits, maxDelegationDepth: 5, maxCostMicros: 1_000_000 },
          },
        });
        if (decision.kind === 'denied') {
          codes.push(decision.code);
          return;
        }
        const child: Node = {
          depth: node.depth + 1,
          maxCostMicros: decision.maxCostMicros,
          costMicros: 0,
          maxDelegationDepth: decision.limits.maxDelegationDepth,
          children: [],
        };
        node.children.push(child);
        run(child, script, codes);
      }
      codes.push('TOOL_CALL_LIMIT');
    }

    const root = (ceiling: number, depth: number): Node => ({
      depth: 0,
      maxCostMicros: ceiling,
      costMicros: 0,
      maxDelegationDepth: depth,
      children: [],
    });

    it.each([
      [1_000, 100, 10, 5],
      [1_000, 333, 7, 5],
      [1_000, 1, 1, 3],
      [999, 500, 499, 5],
      [10_000, 9_999, 1, 5],
      [5, 5, 5, 5],
    ])(
      'stays under a ceiling of %i when each asks %i and spends %i, %i deep',
      (ceiling, ask, spend, depth) => {
        const tree = root(ceiling, depth);
        const codes: string[] = [];
        run(tree, { ask, spend, org: { maxDepth: depth, maxFanOut: 50 } }, codes);
        expect(total(tree)).toBeLessThanOrEqual(ceiling);
      },
    );

    it('reaches the ceiling and stops with a budget code', () => {
      const tree = root(1_000, 5);
      const codes: string[] = [];
      run(tree, { ask: 100, spend: 10, org: { maxDepth: 5, maxFanOut: 50 } }, codes);
      expect(tree.children.length).toBeGreaterThan(0);
      expect(codes).toContain('BUDGET_EXHAUSTED');
      expect(total(tree)).toBeLessThanOrEqual(1_000);
    });

    it('stops at the depth limit first when there is plenty of money', () => {
      const tree = root(1_000_000, 1);
      const codes: string[] = [];
      run(tree, { ask: 1_000, spend: 1, org: { maxDepth: 1, maxFanOut: 2 } }, codes);
      expect(codes).toContain('DELEGATION_DEPTH');
      expect(codes).toContain('TOOL_CALL_LIMIT');
      expect(tree.children).toHaveLength(1_000);
      let deepest = 0;
      const walk = (node: Node) => {
        deepest = Math.max(deepest, node.depth);
        node.children.forEach(walk);
      };
      walk(tree);
      expect(deepest).toBe(1);
    });

    it('holds a child at its whole limit while it runs, so two children cannot share headroom', () => {
      const parent = { ...input().parent, costMicros: 0 };
      const first = decideDelegation(input({ parent, asked: { tools: [], maxCostMicros: 700 } }));
      expect(first).toMatchObject({ kind: 'allowed', maxCostMicros: 700 });
      const second = decideDelegation(
        input({
          parent,
          liveChildren: 1,
          childHolds: [{ maxCostMicros: 700, costMicros: 0 }],
          asked: { tools: [], maxCostMicros: 700 },
        }),
      );
      expect(second).toEqual(denied('BUDGET_EXHAUSTED'));
    });
  });

  describe('classification', () => {
    it.each(
      CLASSIFICATIONS.flatMap((run) =>
        CLASSIFICATIONS.map((work) => [run, work] as [AiClassification, AiClassification]),
      ),
    )('a %s run on %s work never gives a child less', (run, work) => {
      const decision = decideDelegation(
        input({ parent: { ...input().parent, classification: run }, workClassification: work }),
      );
      if (decision.kind !== 'allowed') throw new Error('Expected a child');
      expect(decision.classification).toBe(strongestClassification(run, work));
      expect(CLASSIFICATIONS.indexOf(decision.classification)).toBeGreaterThanOrEqual(
        CLASSIFICATIONS.indexOf(run),
      );
    });
  });

  describe('provider', () => {
    it('denies when the parent has no pinned profile for the child to inherit', () => {
      expect(
        decideDelegation(input({ parent: { ...input().parent, boundToProfile: false } })),
      ).toEqual(denied('DELEGATION_WIDENED', 'PROFILE_NOT_BOUND'));
    });

    it.each(['provider', 'profile_id', 'model', 'endpoint_url', 'budget_id', 'approver', 'depth'])(
      'gives a model no argument to name a %s with',
      (field) => {
        const args = {
          agent_version_id: '00000000-0000-4000-8000-000000000001',
          title: 'Look into it',
          tools: [],
          max_cost_micros: 1,
        };
        expect(agentDelegateArgsSchema.safeParse(args).success).toBe(true);
        expect(agentDelegateArgsSchema.safeParse({ ...args, [field]: 'anything' }).success).toBe(
          false,
        );
      },
    );
  });

  describe('limits', () => {
    it('never gives a child more turns, calls, tokens or time than the parent has', () => {
      const decision = decideDelegation(
        input({
          childManifest: {
            ...input().childManifest,
            limits: {
              maxModelTurns: 999,
              maxToolCalls: 999,
              maxTotalTokens: 999_999,
              maxCostMicros: 999_999,
              timeoutSeconds: 99_999,
              maxDelegationDepth: 5,
            },
          },
        }),
      );
      if (decision.kind !== 'allowed') throw new Error('Expected a child');
      expect(decision.limits.maxModelTurns).toBe(limits.maxModelTurns);
      expect(decision.limits.maxToolCalls).toBe(limits.maxToolCalls);
      expect(decision.limits.maxTotalTokens).toBe(limits.maxTotalTokens);
      expect(decision.limits.timeoutSeconds).toBe(limits.timeoutSeconds);
    });

    it("keeps the child manifest's own lower limits", () => {
      const decision = decideDelegation(
        input({
          childManifest: {
            ...input().childManifest,
            limits: {
              maxModelTurns: 1,
              maxToolCalls: 0,
              maxTotalTokens: 5,
              maxCostMicros: 5,
              timeoutSeconds: 3,
              maxDelegationDepth: 0,
            },
          },
        }),
      );
      expect(decision).toMatchObject({
        kind: 'allowed',
        maxCostMicros: 5,
        limits: {
          maxModelTurns: 1,
          maxToolCalls: 0,
          maxTotalTokens: 5,
          timeoutSeconds: 3,
          maxDelegationDepth: 0,
        },
      });
    });
  });

  it('checks depth before scopes, fan-out and money, so the plainest reason is the one given', () => {
    expect(
      decideDelegation(
        input({
          org: NO_DELEGATION,
          asked: { tools: ['email.send'], maxCostMicros: 1_000_000 },
        }),
      ),
    ).toEqual(denied('DELEGATION_DEPTH'));
    expect(
      decideDelegation(
        input({
          org: { maxDepth: 5, maxFanOut: 0 },
          asked: { tools: ['email.send'], maxCostMicros: 1_000_000 },
        }),
      ),
    ).toEqual(denied('DELEGATION_WIDENED'));
    expect(
      decideDelegation(
        input({
          org: { maxDepth: 5, maxFanOut: 0 },
          asked: { tools: [], maxCostMicros: 1_000_000 },
        }),
      ),
    ).toEqual(denied('DELEGATION_FANOUT'));
  });
});
