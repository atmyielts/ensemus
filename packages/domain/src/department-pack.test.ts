// The rules every department pack has to pass (EXP-01, ADR-033 D1). Each rule gets a pack that breaks it, so a rule
// that stops firing is seen. A real pack passing them all is in each pack's own test file.
import { describe, expect, it } from 'vitest';
import {
  checkDepartmentPack,
  checkPackUpgrade,
  newCapabilitiesIn,
  type DepartmentPackManifest,
  type PackGraph,
} from './department-pack';

const answers: DepartmentPackManifest['agentDrafts'][0]['answers'] = {
  role: 'Drafts a campaign plan from approved sources.',
  intendedOutcome: 'A plan a person can review.',
  boundaries: ['Sends nothing.'],
  toolIds: ['documents.draft.create'],
  triggerKind: 'manual',
  maxCostMicros: null,
  maxTurns: 10,
  maxToolCalls: 10,
  maxTotalTokens: 10_000,
  timeoutSeconds: 60,
  qualityTier: 'balanced',
  autonomy: 'draft_for_review',
  memoryWrite: 'propose_only',
  outputFormat: 'markdown_brief',
  dataClasses: ['internal'],
};

const node = (id: string, kind: PackGraph['nodes'][0]['kind'], extra = {}) => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  ...extra,
});

const safeGraph: PackGraph = {
  schemaVersion: 1,
  nodes: [
    node('s', 'start'),
    node('draft', 'agent_task'),
    node('ok', 'human_approval', { approverRole: 'process_owner' }),
    node('send', 'external_action', { toolId: 'email.send' }),
    node('e', 'end'),
  ],
  edges: [
    { from: 's', to: 'draft' },
    { from: 'draft', to: 'ok' },
    { from: 'ok', to: 'send' },
    { from: 'send', to: 'e' },
  ],
};

const pack: DepartmentPackManifest = {
  schemaVersion: 1,
  key: 'marketing_operations',
  version: '1.0.0',
  name: 'Marketing operations',
  description: 'Campaign planning and artifact review.',
  publisher: 'ensemus',
  capabilities: [
    {
      key: 'object.campaign',
      kind: 'object_type',
      subject: 'campaign',
      reasonCode: 'reason_campaign',
      risk: 'low',
      requiredBy: ['campaign'],
    },
    {
      key: 'tool.draft',
      kind: 'agent_tool',
      subject: 'documents.draft.create',
      reasonCode: 'reason_draft',
      risk: 'low',
      requiredBy: ['campaign_planner'],
    },
    {
      key: 'effect.send',
      kind: 'external_effect',
      subject: 'email.send',
      reasonCode: 'reason_send',
      risk: 'elevated',
      requiredBy: ['campaign_review'],
    },
  ],
  objectTypes: [
    {
      slug: 'campaign',
      displayName: 'Campaign',
      classification: 'internal',
      fields: [
        { key: 'name', label: 'Name', kind: 'text', required: true, indexed: true },
        { key: 'notes', label: 'Notes', kind: 'long_text', required: false, indexed: false },
      ],
      relations: [],
    },
  ],
  agentDrafts: [{ key: 'campaign_planner', name: 'Campaign planner', answers }],
  processes: [
    { key: 'campaign_review', name: 'Review', classification: 'internal', graph: safeGraph },
  ],
  scenarios: [
    {
      key: 'campaign_planner.plans',
      turns: [{ kind: 'finish', citesEvidence: true }],
    },
    {
      key: 'campaign_review.denied_send_without_approval',
      turns: [{ kind: 'tool', toolId: 'email.send', dataClass: 'internal' }],
    },
  ],
  strings: {
    reason_campaign: 'To keep campaigns.',
    reason_draft: 'To draft a plan.',
    reason_send: 'To send what a person approved.',
  },
};

const rules = (changed: DepartmentPackManifest) =>
  checkDepartmentPack(changed).map(({ rule }) => rule);
const object0 = pack.objectTypes[0] as DepartmentPackManifest['objectTypes'][0];
const withGraph = (graph: PackGraph): DepartmentPackManifest => ({
  ...pack,
  processes: [{ key: 'campaign_review', name: 'Review', classification: 'internal', graph }],
});
const withAnswers = (change: Partial<typeof answers>): DepartmentPackManifest => ({
  ...pack,
  agentDrafts: [
    { key: 'campaign_planner', name: 'Campaign planner', answers: { ...answers, ...change } },
  ],
});

describe('the review rules', () => {
  it('pass a pack that follows them', () => {
    expect(checkDepartmentPack(pack)).toEqual([]);
  });

  it.each<[string, DepartmentPackManifest]>([
    ['PACK_KEY_FORMAT', { ...pack, key: 'Not Valid' }],
    ['PACK_VERSION_FORMAT', { ...pack, version: '1' }],
    ['PACK_ASKS_NOTHING', { ...pack, capabilities: [] }],
    ['OBJECT_SLUG_RESERVED', { ...pack, objectTypes: [{ ...object0, slug: 'invoice' }] }],
    ['OBJECT_SLUG_FORMAT', { ...pack, objectTypes: [{ ...object0, slug: 'Bad Slug' }] }],
    ['OBJECT_SLUG_REPEATED', { ...pack, objectTypes: [object0, object0] }],
    ['OBJECT_NO_FIELDS', { ...pack, objectTypes: [{ ...object0, fields: [] }] }],
    [
      'OBJECT_TOO_MANY_INDEXED',
      {
        ...pack,
        objectTypes: [
          {
            ...object0,
            fields: Array.from({ length: 9 }, (_, index) => ({
              key: `field_${index}`,
              label: 'A field',
              kind: 'text' as const,
              required: false,
              indexed: true,
            })),
          },
        ],
      },
    ],
    [
      'FIELD_KEY_REPEATED',
      {
        ...pack,
        objectTypes: [
          {
            ...object0,
            fields: [
              object0.fields[0] as (typeof object0.fields)[0],
              object0.fields[0] as (typeof object0.fields)[0],
            ],
          },
        ],
      },
    ],
    [
      'ENUM_NO_OPTIONS',
      {
        ...pack,
        objectTypes: [
          {
            ...object0,
            fields: [
              { key: 'stage', label: 'Stage', kind: 'enum', required: false, indexed: false },
            ],
          },
        ],
      },
    ],
    [
      'RELATION_UNKNOWN_TYPE',
      {
        ...pack,
        objectTypes: [
          {
            ...object0,
            relations: [{ key: 'x', label: 'X', toTypeSlug: 'nothing', cardinality: 'one' }],
          },
        ],
      },
    ],
    ['OBJECT_NOT_ASKED', { ...pack, capabilities: pack.capabilities.slice(1) }],
    [
      'DATA_CLASS_NOT_ASKED',
      { ...pack, objectTypes: [{ ...object0, classification: 'confidential' }] },
    ],
    [
      'RESTRICTED_NOT_ELEVATED',
      {
        ...pack,
        objectTypes: [{ ...object0, classification: 'restricted' }],
        capabilities: [
          ...pack.capabilities,
          {
            key: 'data.restricted',
            kind: 'data_class',
            subject: 'restricted',
            reasonCode: 'reason_campaign',
            risk: 'low',
            requiredBy: ['campaign'],
          },
        ],
      },
    ],
    [
      'CAPABILITY_KEY_REPEATED',
      { ...pack, capabilities: [...pack.capabilities, pack.capabilities[0]!] },
    ],
    [
      'CAPABILITY_UNKNOWN_ITEM',
      {
        ...pack,
        capabilities: [
          { ...pack.capabilities[0]!, requiredBy: ['nothing'] },
          ...pack.capabilities.slice(1),
        ],
      },
    ],
    [
      'CAPABILITY_REQUIRED_BY_NOTHING',
      {
        ...pack,
        capabilities: [{ ...pack.capabilities[0]!, requiredBy: [] }, ...pack.capabilities.slice(1)],
      },
    ],
    [
      'CAPABILITY_EFFECT_NOT_ELEVATED',
      {
        ...pack,
        capabilities: [...pack.capabilities.slice(0, 2), { ...pack.capabilities[2]!, risk: 'low' }],
      },
    ],
    ['TOOL_NOT_ASKED', withAnswers({ toolIds: ['documents.search'] })],
    ['AGENT_TOOL_HAS_EFFECT', withAnswers({ toolIds: ['email.send'] })],
    ['AGENT_ACTS', withAnswers({ autonomy: 'act_with_approval' })],
    ['AGENT_SETS_COST', withAnswers({ maxCostMicros: 1000 })],
    ['AGENT_NO_BOUNDARIES', withAnswers({ boundaries: [] })],
    ['TOOL_MOVES_MONEY', withAnswers({ toolIds: ['bank.transfer'] })],
    ['TOOL_MOVES_MONEY', withAnswers({ toolIds: ['accounting.payment.create'] })],
    ['TOOL_BULK_OUTREACH', withAnswers({ toolIds: ['email.bulk.send'] })],
    ['TOOL_NEVER_ALLOWED', withAnswers({ toolIds: ['secrets.read'] })],
    [
      'PROCESS_EFFECT_WITHOUT_APPROVAL',
      withGraph({
        ...safeGraph,
        edges: [{ from: 's', to: 'send' }, { from: 'send', to: 'e' }, ...safeGraph.edges],
      }),
    ],
    [
      'PROCESS_CYCLE',
      withGraph({ ...safeGraph, edges: [...safeGraph.edges, { from: 'ok', to: 'draft' }] }),
    ],
    [
      'PROCESS_ONE_START',
      withGraph({ ...safeGraph, nodes: safeGraph.nodes.filter((n) => n.kind !== 'start') }),
    ],
    [
      'PROCESS_NO_END',
      withGraph({ ...safeGraph, nodes: safeGraph.nodes.filter((n) => n.kind !== 'end') }),
    ],
    [
      'PROCESS_DANGLING_EDGE',
      withGraph({ ...safeGraph, edges: [...safeGraph.edges, { from: 's', to: 'nowhere' }] }),
    ],
    [
      'PROCESS_NODE_REPEATED',
      withGraph({ ...safeGraph, nodes: [...safeGraph.nodes, node('s', 'work_item')] }),
    ],
    [
      'PROCESS_EFFECT_NO_TOOL',
      withGraph({
        ...safeGraph,
        nodes: safeGraph.nodes.map((n) => (n.id === 'send' ? node('send', 'external_action') : n)),
      }),
    ],
    [
      'PROCESS_RESTRICTED_EFFECT',
      {
        ...pack,
        processes: [
          {
            key: 'campaign_review',
            name: 'Review',
            classification: 'restricted',
            graph: safeGraph,
          },
        ],
      },
    ],
    [
      'PROCESS_LABEL_TOO_LONG',
      withGraph({
        ...safeGraph,
        nodes: [...safeGraph.nodes.slice(1), node('s', 'start', { label: 'x'.repeat(121) })],
      }),
    ],
    [
      'SCENARIO_NO_GUARDRAIL',
      { ...pack, scenarios: pack.scenarios.filter((s) => !s.key.includes('denied_')) },
    ],
    [
      'SCENARIO_ITEM_NOT_COVERED',
      { ...pack, scenarios: pack.scenarios.filter((s) => s.key.includes('denied_')) },
    ],
    [
      'SCENARIO_UNKNOWN_ITEM',
      { ...pack, scenarios: [...pack.scenarios, { key: 'nothing.at_all', turns: [] }] },
    ],
    ['STRINGS_MISSING_KEY', { ...pack, strings: { reason_campaign: 'x', reason_draft: 'y' } }],
    [
      'STRINGS_COMPLIANCE_CLAIM',
      { ...pack, description: 'Keeps your campaigns compliant with the law.' },
    ],
    [
      'STRINGS_COMPLIANCE_CLAIM',
      { ...pack, strings: { ...pack.strings, reason_draft: 'A certified method.' } },
    ],
    ['STRINGS_COMPLIANCE_CLAIM', withAnswers({ intendedOutcome: 'Guaranteed results.' })],
  ])('catch %s', (rule, changed) => {
    expect(rules(changed)).toContain(rule);
  });

  it('let a read or a draft be an agent tool', () => {
    for (const tool of ['documents.search', 'crm.accounts.read', 'documents.draft.create']) {
      expect(rules(withAnswers({ toolIds: [tool] }))).not.toContain('AGENT_TOOL_HAS_EFFECT');
    }
  });

  it('see an effect on any path, even if another path has its approval', () => {
    const twoPaths = withGraph({
      ...safeGraph,
      edges: [...safeGraph.edges, { from: 'draft', to: 'send' }],
    });
    expect(checkDepartmentPack(twoPaths)).toContainEqual({
      rule: 'PROCESS_EFFECT_WITHOUT_APPROVAL',
      subject: 'send',
    });
  });

  it('name the offending key, and never its words', () => {
    const claims: DepartmentPackManifest = {
      ...pack,
      strings: { ...pack.strings, reason_draft: 'Certified and compliant.' },
    };
    expect(JSON.stringify(checkDepartmentPack(claims))).not.toContain('Certified');
  });
});

describe('the rollback rules', () => {
  const next = (changes: Partial<DepartmentPackManifest>): DepartmentPackManifest => ({
    ...pack,
    version: '1.1.0',
    ...changes,
  });
  const upgrade = (changes: Partial<DepartmentPackManifest>) =>
    checkPackUpgrade(pack, next(changes)).map(({ rule }) => rule);

  it('pass an upgrade that only adds', () => {
    expect(
      upgrade({
        objectTypes: [
          {
            ...object0,
            fields: [
              ...object0.fields,
              { key: 'budget_code', label: 'Code', kind: 'text', required: false, indexed: false },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('refuse another pack, or going backwards or nowhere', () => {
    expect(upgrade({ key: 'hr_operations' })).toContain('UPGRADE_OTHER_PACK');
    expect(upgrade({ version: '1.0.0' })).toContain('UPGRADE_NOT_FORWARD');
    expect(upgrade({ version: '0.9.9' })).toContain('UPGRADE_NOT_FORWARD');
    expect(upgrade({ version: '1.0' })).toContain('UPGRADE_NOT_FORWARD');
  });

  it('compare versions as numbers', () => {
    const ten = { ...pack, version: '1.10.0' };
    expect(checkPackUpgrade({ ...pack, version: '1.9.0' }, ten)).toEqual([]);
    expect(checkPackUpgrade(ten, { ...pack, version: '1.9.0' }).map((f) => f.rule)).toContain(
      'UPGRADE_NOT_FORWARD',
    );
  });

  it('refuse removing anything, because rollback never loses data', () => {
    expect(upgrade({ objectTypes: [] })).toContain('UPGRADE_REMOVES_ITEM');
    expect(upgrade({ agentDrafts: [] })).toContain('UPGRADE_REMOVES_ITEM');
    expect(upgrade({ processes: [] })).toContain('UPGRADE_REMOVES_ITEM');
    expect(upgrade({ capabilities: [] })).toContain('UPGRADE_REMOVES_CAPABILITY');
    expect(
      upgrade({ objectTypes: [{ ...object0, fields: object0.fields.slice(0, 1) }] }),
    ).toContain('UPGRADE_REMOVES_FIELD');
  });

  it('refuse changing what is already there underneath', () => {
    expect(upgrade({ objectTypes: [{ ...object0, classification: 'public' }] })).toContain(
      'UPGRADE_CHANGES_CLASS',
    );
    expect(
      upgrade({
        objectTypes: [
          {
            ...object0,
            fields: [
              { key: 'name', label: 'Name', kind: 'number', required: true, indexed: true },
              object0.fields[1] as (typeof object0.fields)[0],
            ],
          },
        ],
      }),
    ).toContain('UPGRADE_CHANGES_FIELD');
  });

  it('refuse a capability that quietly comes to mean something else', () => {
    expect(
      upgrade({
        capabilities: [
          { ...pack.capabilities[0]!, subject: 'employment_record' },
          ...pack.capabilities.slice(1),
        ],
      }),
    ).toContain('UPGRADE_CHANGES_CAPABILITY');
  });

  it('say what is new, for M7 to send back to a person', () => {
    const more = next({
      capabilities: [
        ...pack.capabilities,
        {
          key: 'tool.crm',
          kind: 'agent_tool',
          subject: 'crm.accounts.read',
          reasonCode: 'reason_draft',
          risk: 'low',
          requiredBy: ['campaign_planner'],
        },
      ],
    });
    expect(newCapabilitiesIn(pack, more)).toEqual(['tool.crm']);
    expect(newCapabilitiesIn(pack, next({}))).toEqual([]);
  });
});
