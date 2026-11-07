// AGENT-14, QA-039, QA-040, TR-032 at the level of pure rules. `validateObjectSchema`, `planTypeMigration` and
// `compileProcessGraph` belong to the objects and graph slices, and are stubs on this branch. The doubles below
// stand in only while the real one says NOT_IMPLEMENTED, so after the merge these tests run against the real
// rules without being edited.
import { describe, expect, it, vi } from 'vitest';
import type { ToolFacts } from './agent-draft';
import type { ObjectField, TypeMigrationPlan } from './custom-object';
import {
  comparePackVersions,
  dataAccessStringKey,
  itemsAllowedBy,
  mergePackTypeShape,
  planPackItems,
  planPackRollback,
  planPackUpgrade,
  sideEffectsStringKey,
  validatePackManifest,
  type PackCapability,
  type PackManifest,
} from './pack';
import type { CompileResult, GraphIssue, ProcessGraph } from './process-spec';

const stubs = vi.hoisted(() => ({
  orElse:
    <A extends unknown[], R>(real: (...args: A) => R, fallback: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return real(...args);
      } catch (error) {
        if (error instanceof Error && error.message === 'NOT_IMPLEMENTED') return fallback(...args);
        throw error;
      }
    },
}));

vi.mock('./custom-object', async (importOriginal) => {
  const real = await importOriginal<typeof import('./custom-object')>();
  const plan = (from: readonly ObjectField[], to: readonly ObjectField[]): TypeMigrationPlan => {
    const steps: TypeMigrationPlan['steps'][number][] = [];
    for (const field of from) {
      const next = to.find((candidate) => candidate.key === field.key);
      if (!next) steps.push({ kind: 'remove', key: field.key, refused: true });
      else if (next.kind !== field.kind) {
        steps.push({ kind: 'change_kind', key: field.key, refused: true });
      }
    }
    for (const field of to) {
      if (from.some((candidate) => candidate.key === field.key)) continue;
      steps.push(
        field.required
          ? { kind: 'add_required', key: field.key, refused: true }
          : { kind: 'add_optional', key: field.key },
      );
    }
    return { safe: !steps.some((step) => 'refused' in step), steps };
  };
  return {
    ...real,
    validateObjectSchema: stubs.orElse(real.validateObjectSchema, () => []),
    planTypeMigration: stubs.orElse(real.planTypeMigration, plan),
  };
});

vi.mock('./process-spec', async (importOriginal) => {
  const real = await importOriginal<typeof import('./process-spec')>();
  // Only the rule this file leans on: every path to an effect passes an approval.
  const compile = (graph: ProcessGraph): CompileResult => {
    const issues: GraphIssue[] = [];
    const start = graph.nodes.find((node) => node.kind === 'start');
    const walk = (id: string, approved: boolean, seen: readonly string[]) => {
      if (seen.includes(id)) return;
      const node = graph.nodes.find((candidate) => candidate.id === id);
      if (!node) return;
      if (node.kind === 'external_action' && !approved) {
        issues.push({ nodeId: id, code: 'EFFECT_WITHOUT_APPROVAL' });
      }
      for (const edge of graph.edges.filter((candidate) => candidate.from === id)) {
        walk(edge.to, approved || node.kind === 'human_approval', [...seen, id]);
      }
    };
    if (start) walk(start.id, false, []);
    return issues.length > 0
      ? { ok: false, spec: null, specSha256: null, issues }
      : {
          ok: true,
          spec: { schemaVersion: 1, classification: 'internal', steps: [] },
          specSha256: '',
          issues: [],
        };
  };
  return { ...real, compileProcessGraph: stubs.orElse(real.compileProcessGraph, compile) };
});

const words = (key: string, reason = `reason.${key}`) => ({
  [reason]: 'Why this is asked for.',
  [dataAccessStringKey(key)]: 'What it can read.',
  [sideEffectsStringKey(key)]: 'What it can change.',
});

const capability = (over: Partial<PackCapability> & { key: string }): PackCapability => ({
  kind: 'agent_tool',
  subject: 'work.read',
  reasonCode: `reason.${over.key}`,
  risk: 'low',
  requiredBy: ['agent_draft:helper'],
  ...over,
});

const answers = {
  role: 'Helps.',
  intendedOutcome: 'A draft.',
  boundaries: ['Sends nothing.'],
  toolIds: ['work.read'],
  triggerKind: 'manual',
  maxCostMicros: null,
  maxTurns: 5,
  maxToolCalls: 5,
  maxTotalTokens: 1000,
  timeoutSeconds: 60,
  qualityTier: 'balanced',
  autonomy: 'draft_for_review',
  memoryWrite: 'none',
  outputFormat: 'markdown_brief',
  dataClasses: ['internal'],
} as const;

const safeGraph: ProcessGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'a', kind: 'start', label: 'Start', x: 0, y: 0 },
    { id: 'b', kind: 'human_approval', label: 'Ask', x: 1, y: 0, approverRole: 'process_owner' },
    { id: 'c', kind: 'external_action', label: 'Send', x: 2, y: 0, toolId: 'email.send' },
    { id: 'd', kind: 'end', label: 'End', x: 3, y: 0 },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ],
};

const field = (key: string, over: Partial<ObjectField> = {}): ObjectField => ({
  key,
  label: key,
  kind: 'text',
  required: false,
  indexed: false,
  ...over,
});

const base = (over: Partial<PackManifest> = {}): PackManifest => ({
  schemaVersion: 1,
  key: 'test-pack',
  version: '1.0.0',
  name: 'Test pack',
  description: 'A pack for tests.',
  publisher: 'ensemus',
  capabilities: [
    capability({
      key: 'type.thing',
      kind: 'object_type',
      subject: 'thing',
      requiredBy: ['object_type:thing'],
    }),
    capability({ key: 'tool.work.read' }),
    capability({
      key: 'data.internal',
      kind: 'data_class',
      subject: 'internal',
      requiredBy: ['agent_draft:helper', 'process_draft:send'],
    }),
    capability({
      key: 'effect.email.send',
      kind: 'external_effect',
      subject: 'email.send',
      risk: 'elevated',
      requiredBy: ['process_draft:send'],
    }),
  ],
  objectTypes: [
    {
      slug: 'thing',
      displayName: 'Thing',
      classification: 'internal',
      fields: [field('title')],
      relations: [],
    },
  ],
  agentDrafts: [{ key: 'helper', name: 'Helper', answers }],
  processes: [{ key: 'send', name: 'Send', classification: 'internal', graph: safeGraph }],
  scenarios: [
    { key: 'test.standard', turns: [{ kind: 'finish', citesEvidence: true }] },
    {
      key: 'test.prompt_injection',
      turns: [{ kind: 'tool', toolId: 'secrets.read', dataClass: 'restricted' }],
    },
  ],
  strings: {
    ...words('type.thing'),
    ...words('tool.work.read'),
    ...words('data.internal'),
    ...words('effect.email.send'),
  },
  ...over,
});

const codes = (manifest: PackManifest) => validatePackManifest(manifest).map((issue) => issue.code);

const withCapability = (over: Partial<PackCapability> & { key: string }) => {
  const manifest = base();
  return {
    ...manifest,
    capabilities: manifest.capabilities.map((item) =>
      item.key === over.key ? { ...item, ...over } : item,
    ),
  };
};

const allAccepted = (manifest: PackManifest) =>
  Object.fromEntries(manifest.capabilities.map((item) => [item.key, 'accepted' as const]));

const TOOLS: readonly ToolFacts[] = [
  { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'email.send', version: '1', class: 'external_write', requiresApproval: true },
];

describe('validatePackManifest', () => {
  it('accepts a sound manifest', () => {
    expect(validatePackManifest(base())).toEqual([]);
  });

  it.each([
    ['schema version', { schemaVersion: 2 as 1 }, 'BAD_SCHEMA_VERSION'],
    ['pack key', { key: 'Not A Key' }, 'BAD_KEY'],
    ['version', { version: '1.0' }, 'BAD_VERSION'],
    ['publisher', { publisher: 'someone' as 'ensemus' }, 'BAD_PUBLISHER'],
    ['name', { name: '  ' }, 'REQUIRED'],
  ] as const)('refuses a bad %s', (_what, over, code) => {
    expect(codes(base(over))).toContain(code);
  });

  it.each([
    ['secrets.read'],
    ['secret.read'],
    ['model.call'],
    ['budget.raise'],
    ['policy.change'],
    ['grant.issue'],
  ])('refuses the forbidden tool %s, as Studio does', (toolId) => {
    const manifest = base({
      agentDrafts: [{ key: 'helper', name: 'Helper', answers: { ...answers, toolIds: [toolId] } }],
      capabilities: [...base().capabilities, capability({ key: 'tool.bad', subject: toolId })],
      strings: { ...base().strings, ...words('tool.bad') },
    });
    expect(codes(manifest)).toContain('FORBIDDEN_TOOL_REFUSED');
  });

  it.each([
    ['email.send_bulk'],
    ['email.bulk_send'],
    ['bulk.email'],
    ['mass_mail.send'],
    ['email.broadcast'],
    ['campaign.send'],
  ])('refuses the bulk tool %s, wherever it is named', (toolId) => {
    const named = base({
      agentDrafts: [
        {
          key: 'helper',
          name: 'Helper',
          answers: { ...answers, toolIds: [toolId], autonomy: 'act_with_approval' },
        },
      ],
      capabilities: [...base().capabilities, capability({ key: 'tool.bad', subject: toolId })],
      strings: { ...base().strings, ...words('tool.bad') },
    });
    expect(codes(named)).toContain('BULK_TOOL_REFUSED');

    const graph = {
      ...safeGraph,
      nodes: safeGraph.nodes.map((node) => (node.id === 'c' ? { ...node, toolId } : node)),
    };
    const drawn = base({
      processes: [{ key: 'send', name: 'Send', classification: 'internal', graph }],
    });
    expect(codes(drawn)).toContain('BULK_TOOL_REFUSED');
  });

  it('refuses restricted data for an agent', () => {
    const manifest = base({
      agentDrafts: [
        {
          key: 'helper',
          name: 'Helper',
          answers: { ...answers, dataClasses: ['restricted' as 'internal'] },
        },
      ],
    });
    expect(codes(manifest)).toContain('RESTRICTED_NOT_OFFERED');
  });

  it('refuses a request for restricted data', () => {
    expect(
      codes(withCapability({ key: 'data.internal', subject: 'restricted', risk: 'elevated' })),
    ).toContain('RESTRICTED_NOT_OFFERED');
  });

  it('refuses an effect that is not declared elevated', () => {
    expect(codes(withCapability({ key: 'effect.email.send', risk: 'low' }))).toContain(
      'EFFECT_MUST_BE_ELEVATED',
    );
  });

  it('refuses confidential data that is not declared elevated', () => {
    const manifest = base({
      agentDrafts: [
        {
          key: 'helper',
          name: 'Helper',
          answers: { ...answers, dataClasses: ['confidential'] },
        },
      ],
      capabilities: [
        ...base().capabilities,
        capability({
          key: 'data.confidential',
          kind: 'data_class',
          subject: 'confidential',
        }),
      ],
      strings: { ...base().strings, ...words('data.confidential') },
    });
    expect(codes(manifest)).toContain('CONFIDENTIAL_MUST_BE_ELEVATED');
  });

  it('refuses an agent with an external effect unless it acts with approval', () => {
    const manifest = base({
      agentDrafts: [
        {
          key: 'helper',
          name: 'Helper',
          answers: { ...answers, toolIds: ['work.read', 'email.send'] },
        },
      ],
      capabilities: base().capabilities.map((item) =>
        item.key === 'effect.email.send'
          ? { ...item, requiredBy: ['agent_draft:helper', 'process_draft:send'] }
          : item,
      ),
    });
    expect(codes(manifest)).toContain('TOOL_NEEDS_APPROVAL_MODE');
  });

  it('refuses a tool, a data class or a type nobody is asked about', () => {
    const noTool = base({
      capabilities: base().capabilities.filter((item) => item.key !== 'tool.work.read'),
    });
    expect(codes(noTool)).toContain('MISSING_CAPABILITY');
    const noData = base({
      capabilities: base().capabilities.filter((item) => item.key !== 'data.internal'),
    });
    expect(codes(noData)).toContain('MISSING_CAPABILITY');
    const noType = base({
      capabilities: base().capabilities.filter((item) => item.key !== 'type.thing'),
    });
    expect(codes(noType)).toContain('MISSING_CAPABILITY');
    const noEffect = base({
      capabilities: base().capabilities.filter((item) => item.key !== 'effect.email.send'),
    });
    expect(codes(noEffect)).toContain('MISSING_CAPABILITY');
  });

  it('refuses a request that keeps nothing out, or names an item that does not exist', () => {
    expect(codes(withCapability({ key: 'tool.work.read', requiredBy: [] }))).toContain('REQUIRED');
    expect(
      codes(withCapability({ key: 'tool.work.read', requiredBy: ['agent_draft:nobody'] })),
    ).toContain('UNKNOWN_ITEM');
  });

  it('refuses a request with no plain words for its data access or side effects', () => {
    const { strings } = base();
    const without = (key: string) => base({ strings: { ...strings, [key]: '  ' } });
    expect(codes(without(dataAccessStringKey('tool.work.read')))).toContain('NO_WORDS');
    expect(codes(without(sideEffectsStringKey('tool.work.read')))).toContain('NO_WORDS');
    expect(codes(without('reason.tool.work.read'))).toContain('NO_WORDS');
  });

  it('refuses repeated keys', () => {
    const { capabilities } = base();
    expect(codes(base({ capabilities: [...capabilities, capabilities[0]!] }))).toContain(
      'DUPLICATE_KEY',
    );
  });

  it('refuses a manifest that tries to name an owner or a knowledge source', () => {
    const smuggled = {
      ...answers,
      ownerMembershipId: 'someone',
      knowledgeSourceIds: ['everything'],
    };
    const issues = validatePackManifest(
      base({ agentDrafts: [{ key: 'helper', name: 'Helper', answers: smuggled }] }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'agentDrafts[0].answers.ownerMembershipId', code: 'NOT_ALLOWED' },
        { path: 'agentDrafts[0].answers.knowledgeSourceIds', code: 'NOT_ALLOWED' },
      ]),
    );
  });

  it('refuses a workflow that names one of the tenant agents', () => {
    const graph: ProcessGraph = {
      ...safeGraph,
      nodes: [
        ...safeGraph.nodes,
        { id: 'e', kind: 'agent_task', label: 'Task', x: 0, y: 1, agentDefinitionId: 'an-agent' },
      ],
    };
    expect(
      codes(
        base({ processes: [{ key: 'send', name: 'Send', classification: 'internal', graph }] }),
      ),
    ).toContain('AGENT_REFERENCE_NOT_ALLOWED');
  });

  it('refuses a workflow with a path to an effect and no approval on it', () => {
    const graph: ProcessGraph = {
      ...safeGraph,
      edges: [...safeGraph.edges, { from: 'a', to: 'c' }],
    };
    expect(
      codes(
        base({ processes: [{ key: 'send', name: 'Send', classification: 'internal', graph }] }),
      ),
    ).toContain('GRAPH_EFFECT_WITHOUT_APPROVAL');
  });

  it.each([
    ['Fully GDPR compliant.'],
    ['Keeps you compliant.'],
    ['Certified for sales teams.'],
    ['SOC 2 ready.'],
    ['Guaranteed delivery.'],
    ['Legally reviewed.'],
    ['From $49 a month.'],
    ['Lowest pricing.'],
    ['Increases revenue.'],
    ['Close more deals.'],
    ['Saves 30% of your time.'],
    ['Proven results.'],
  ])('refuses the claim %j anywhere in its words', (claim) => {
    expect(codes(base({ description: claim }))).toContain('CLAIM_NOT_ALLOWED');
    expect(codes(base({ strings: { ...base().strings, extra: claim } }))).toContain(
      'CLAIM_NOT_ALLOWED',
    );
    expect(
      codes(
        base({
          agentDrafts: [
            { key: 'helper', name: 'Helper', answers: { ...answers, intendedOutcome: claim } },
          ],
        }),
      ),
    ).toContain('CLAIM_NOT_ALLOWED');
  });

  it('refuses a relation to a type that is not made first', () => {
    const type = base().objectTypes[0]!;
    const manifest = base({
      objectTypes: [
        {
          ...type,
          relations: [{ key: 'other', label: 'Other', toTypeSlug: 'later', cardinality: 'one' }],
        },
      ],
    });
    expect(codes(manifest)).toContain('UNKNOWN_RELATION_TARGET');
  });
});

describe('comparePackVersions', () => {
  it('compares by number, not by text', () => {
    expect(comparePackVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(comparePackVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(comparePackVersions('1.0.0', '1.0.0')).toBe(0);
    expect(comparePackVersions('1.0', '1.0.0')).toBeNull();
  });
});

describe('planPackUpgrade', () => {
  const next = (over: Partial<PackManifest> = {}) => base({ version: '1.1.0', ...over });

  it('keeps what did not change, and asks nothing new', () => {
    const plan = planPackUpgrade(base(), next());
    expect(plan.refused).toBe(false);
    expect(plan.needsReview).toBe(false);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        { kind: 'keep_item', itemKind: 'object_type', key: 'thing' },
        { kind: 'keep_item', itemKind: 'agent_draft', key: 'helper' },
        { kind: 'keep_item', itemKind: 'process_draft', key: 'send' },
      ]),
    );
  });

  it.each([
    ['a downgrade', '0.9.0'],
    ['the same version', '1.0.0'],
    ['a version that is not one', 'latest'],
  ])('refuses %s', (_what, version) => {
    expect(planPackUpgrade(base(), base({ version })).refused).toBe(true);
  });

  it('refuses another pack', () => {
    expect(planPackUpgrade(base(), next({ key: 'other-pack' })).refused).toBe(true);
  });

  it('refuses a step that removes a type, a draft or a workflow', () => {
    for (const over of [{ objectTypes: [] }, { agentDrafts: [] }, { processes: [] }]) {
      const plan = planPackUpgrade(base(), next(over));
      expect(plan.refused).toBe(true);
      expect(plan.steps.some((step) => step.kind === 'remove_item')).toBe(true);
    }
  });

  it('brings a new capability back for review, whatever was accepted before', () => {
    const plan = planPackUpgrade(
      base(),
      next({
        capabilities: [
          ...base().capabilities,
          capability({ key: 'tool.more', subject: 'artifact.read_text' }),
        ],
        strings: { ...base().strings, ...words('tool.more') },
      }),
    );
    expect(plan.needsReview).toBe(true);
    expect(plan.steps).toContainEqual({ kind: 'new_capability', key: 'tool.more' });
  });

  it('brings a capability back when it asks for more under the same name', () => {
    const wider = base().capabilities.map((item) =>
      item.key === 'tool.work.read' ? { ...item, risk: 'elevated' as const } : item,
    );
    const plan = planPackUpgrade(base(), next({ capabilities: wider }));
    expect(plan.needsReview).toBe(true);
    expect(plan.steps).toContainEqual({ kind: 'new_capability', key: 'tool.work.read' });
  });

  it('moves a type by the migration rules when the change is safe', () => {
    const type = base().objectTypes[0]!;
    const plan = planPackUpgrade(
      base(),
      next({ objectTypes: [{ ...type, fields: [...type.fields, field('extra')] }] }),
    );
    expect(plan.refused).toBe(false);
    expect(plan.steps).toContainEqual({ kind: 'migrate_type', key: 'thing' });
  });

  it.each([
    ['a removed field', { fields: [] }],
    ['a changed kind', { fields: [field('title', { kind: 'number' })] }],
    ['a new required field', { fields: [field('title'), field('needed', { required: true })] }],
    ['a lower classification', { classification: 'public' as const }],
  ])('refuses %s on a type', (_what, change) => {
    const type = base().objectTypes[0]!;
    const plan = planPackUpgrade(base(), next({ objectTypes: [{ ...type, ...change }] }));
    expect(plan.refused).toBe(true);
  });

  it('refuses dropping a relation, because records hold it', () => {
    const type = base().objectTypes[0]!;
    const related = {
      ...type,
      relations: [{ key: 'self', label: 'Self', toTypeSlug: 'thing', cardinality: 'one' as const }],
    };
    const plan = planPackUpgrade(base({ objectTypes: [related] }), next({ objectTypes: [type] }));
    expect(plan.refused).toBe(true);
  });

  it('allows a stricter classification', () => {
    const type = base().objectTypes[0]!;
    const plan = planPackUpgrade(
      base(),
      next({ objectTypes: [{ ...type, classification: 'confidential' }] }),
    );
    expect(plan.refused).toBe(false);
    expect(plan.steps).toContainEqual({ kind: 'migrate_type', key: 'thing' });
  });

  it('makes a new draft when the answers change, and adds what is new', () => {
    const plan = planPackUpgrade(
      base(),
      next({
        agentDrafts: [
          { key: 'helper', name: 'Helper', answers: { ...answers, boundaries: ['Different.'] } },
          { key: 'second', name: 'Second', answers },
        ],
      }),
    );
    expect(plan.steps).toContainEqual({ kind: 'new_draft_version', key: 'helper' });
    expect(plan.steps).toContainEqual({ kind: 'add_item', itemKind: 'agent_draft', key: 'second' });
  });
});

describe('itemsAllowedBy', () => {
  it('allows everything only when each thing was accepted by name', () => {
    expect(itemsAllowedBy(base(), allAccepted(base()))).toEqual({
      objectTypes: ['thing'],
      agentDrafts: ['helper'],
      processes: ['send'],
    });
  });

  it('leaves out what a declined capability is required by, and nothing else', () => {
    expect(
      itemsAllowedBy(base(), { ...allAccepted(base()), 'effect.email.send': 'declined' }),
    ).toEqual({ objectTypes: ['thing'], agentDrafts: ['helper'], processes: [] });
  });

  it('treats an undecided capability as not accepted', () => {
    expect(itemsAllowedBy(base(), {})).toEqual({
      objectTypes: [],
      agentDrafts: [],
      processes: [],
    });
  });

  it('is not fooled by a capability named like something every object has', () => {
    const manifest = base({
      capabilities: [
        capability({ key: 'constructor', subject: 'work.read' }),
        ...base().capabilities.filter((item) => item.key !== 'tool.work.read'),
      ],
    });
    const decisions = Object.fromEntries(
      manifest.capabilities
        .filter((item) => item.key !== 'constructor')
        .map((item) => [item.key, 'accepted' as const]),
    );
    expect(itemsAllowedBy(manifest, decisions).agentDrafts).toEqual([]);
  });

  it('leaves out a type that points at a type left out', () => {
    const type = base().objectTypes[0]!;
    const child = {
      ...type,
      slug: 'child',
      relations: [
        { key: 'thing', label: 'Thing', toTypeSlug: 'thing', cardinality: 'one' as const },
      ],
    };
    const manifest = base({
      objectTypes: [type, child],
      capabilities: [
        ...base().capabilities,
        capability({
          key: 'type.child',
          kind: 'object_type',
          subject: 'child',
          requiredBy: ['object_type:child'],
        }),
      ],
    });
    expect(
      itemsAllowedBy(manifest, { ...allAccepted(manifest), 'type.thing': 'declined' }).objectTypes,
    ).toEqual([]);
  });
});

describe('planPackItems', () => {
  it('makes everything that was accepted and has its tools', () => {
    const plan = planPackItems(base(), allAccepted(base()), TOOLS);
    expect(plan).toEqual({
      objectTypes: ['thing'],
      agentDrafts: ['helper'],
      processes: ['send'],
      leftOut: [],
    });
  });

  it('says why a declined item is left out', () => {
    const plan = planPackItems(
      base(),
      { ...allAccepted(base()), 'effect.email.send': 'declined' },
      TOOLS,
    );
    expect(plan.processes).toEqual([]);
    expect(plan.leftOut).toEqual([
      { ref: 'process_draft:send', reason: 'declined', subject: null },
    ]);
  });

  it('leaves out an item whose tool M4 does not have, and says which', () => {
    const plan = planPackItems(
      base(),
      allAccepted(base()),
      TOOLS.filter((tool) => tool.id !== 'email.send'),
    );
    expect(plan.processes).toEqual([]);
    expect(plan.agentDrafts).toEqual(['helper']);
    expect(plan.leftOut).toEqual([
      { ref: 'process_draft:send', reason: 'tool_unavailable', subject: 'email.send' },
    ]);
  });

  it('makes only what names no tool while the catalog cannot be read', () => {
    const plan = planPackItems(base(), allAccepted(base()), null);
    expect(plan.objectTypes).toEqual(['thing']);
    expect(plan.agentDrafts).toEqual([]);
    expect(plan.processes).toEqual([]);
    expect(plan.leftOut.map((item) => item.reason)).toEqual([
      'catalog_unavailable',
      'catalog_unavailable',
    ]);
  });

  it('leaves out a send that would not ask for approval, whatever the manifest says', () => {
    const plan = planPackItems(base(), allAccepted(base()), [
      TOOLS[0]!,
      { id: 'email.send', version: '1', class: 'external_write', requiresApproval: false },
    ]);
    expect(plan.leftOut).toEqual([
      { ref: 'process_draft:send', reason: 'tool_without_approval', subject: 'email.send' },
    ]);
  });

  it('leaves out an item when the catalog says its tool is riskier than the request said', () => {
    const plan = planPackItems(base(), allAccepted(base()), [
      { id: 'work.read', version: '1', class: 'delegation', requiresApproval: false },
      TOOLS[1]!,
    ]);
    expect(plan.leftOut).toEqual([
      { ref: 'agent_draft:helper', reason: 'capability_understated', subject: 'work.read' },
    ]);
  });
});

describe('planPackRollback', () => {
  const kept = { kind: 'agent_draft', key: 'kept', id: 'id-kept' };
  const type = { kind: 'object_type', key: 'thing', id: 'id-type' };
  const newType = { kind: 'object_type', key: 'added', id: 'id-new-type' };
  const editing = { kind: 'agent_draft', key: 'editing', id: 'id-editing' };
  const inReview = { kind: 'process_draft', key: 'review', id: 'id-review' };
  const published = { kind: 'agent_draft', key: 'published', id: 'id-published' };
  const spec = { kind: 'process_spec', key: 'spec', id: 'id-spec' };
  const gone = { kind: 'agent_draft', key: 'gone', id: 'id-gone' };

  const plan = planPackRollback(
    [kept, type, newType, editing, inReview, published, spec, gone],
    [kept, type],
    {
      'id-kept': 'editing',
      'id-editing': 'editing',
      'id-review': 'in_review',
      'id-published': 'published',
      'id-gone': 'archived',
    },
  );

  it('archives only unpublished drafts the newer version made', () => {
    expect(plan.archive).toEqual([editing, inReview]);
  });

  it('keeps every type, and touches nothing the older version also holds', () => {
    expect(plan.keptTypes).toEqual([newType]);
    expect(plan.archive).not.toContainEqual(kept);
  });

  it('lists what was published for a person to decide on, and archives none of it', () => {
    expect(plan.published).toEqual([published, spec]);
  });
});

describe('mergePackTypeShape', () => {
  it('adds the pack change on top of what a person added since', () => {
    const from = { fields: [field('title')], relations: [] };
    const to = { fields: [field('title'), field('extra')], relations: [] };
    const current = { fields: [field('title'), field('mine', { required: true })], relations: [] };
    const merged = mergePackTypeShape(current, from, to);
    expect(merged.changed).toBe(true);
    expect(merged.shape.fields.map((item) => item.key)).toEqual(['title', 'mine', 'extra']);
    expect(merged.plan.safe).toBe(true);
  });

  it('leaves alone a field a person has already changed', () => {
    const from = { fields: [field('title')], relations: [] };
    const to = { fields: [field('title', { maxLength: 50 })], relations: [] };
    const current = { fields: [field('title', { indexed: true })], relations: [] };
    const merged = mergePackTypeShape(current, from, to);
    expect(merged.shape.fields).toEqual(current.fields);
    expect(merged.changed).toBe(false);
  });

  it('changes nothing when the type already has the shape', () => {
    const shape = { fields: [field('title')], relations: [] };
    expect(mergePackTypeShape(shape, shape, shape).changed).toBe(false);
  });
});
