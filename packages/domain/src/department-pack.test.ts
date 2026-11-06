// The pack format's review and rollback rules (EXP-01, ADR-033 D1). Each rule gets a pack that breaks it, so a
// rule that stops firing is seen. A real pack passing them all is in each pack's own test file.
import { describe, expect, it } from 'vitest';
import {
  checkDepartmentPack,
  checkPackUpgrade,
  type DepartmentPack,
  type PackAgent,
} from './department-pack';

const agent: PackAgent = {
  api_version: 'ensemus.ai/v1',
  id: 'campaign-planner',
  version: 1,
  objective: 'Draft a campaign plan from approved sources, for a person to review.',
  model: {
    required_capabilities: ['text'],
    quality_tier: 'balanced',
    fallback: 'approved_profiles_only',
  },
  context: { allowed_scopes: ['knowledge.marketing.read'], memory_write_policy: 'propose_only' },
  skills: [],
  tools: { allow: ['documents.draft.create'], deny: ['email.send'] },
  execution: {
    max_model_turns: 10,
    max_tool_calls: 10,
    max_cost_usd: 0,
    timeout_seconds: 60,
    max_delegation_depth: 0,
  },
  output: { schema_ref: 'schemas/plan.schema.json', verification: ['schema_check'] },
  evaluation: { suite_ref: 'evals/campaign-planner-v1', min_pass_rate: 0.9 },
};

const pack: DepartmentPack = {
  id: 'marketing_operations',
  version: 1,
  department: 'marketing',
  titleKey: 'title',
  summaryKey: 'summary',
  guardrailKey: 'guardrail',
  objects: [
    {
      name: 'campaign',
      labelKey: 'campaign',
      classification: 'internal',
      fields: [
        { name: 'name', labelKey: 'name', type: 'text', required: true, indexed: true },
        { name: 'notes', labelKey: 'notes', type: 'text', required: false, indexed: false },
      ],
    },
  ],
  views: [{ name: 'campaigns', labelKey: 'campaigns', object: 'campaign', columns: ['name'] }],
  agents: [agent],
  skills: [
    { id: 'source-check', version: '1.0.0', titleKey: 'skill', instructionsKey: 'skill_steps' },
  ],
  workflows: [
    {
      name: 'campaign_review',
      titleKey: 'workflow',
      maxIterations: 3,
      steps: [
        { kind: 'agent_task', id: 'draft', agent: 'campaign-planner', titleKey: 'draft' },
        { kind: 'approval', id: 'approve', titleKey: 'approve', approverRole: 'reviewer' },
        { kind: 'side_effect', id: 'send', tool: 'email.send', titleKey: 'send' },
      ],
    },
  ],
  requests: {
    capabilities: [{ capability: 'work.create', reasonKey: 'reason', grantedOnInstall: false }],
    dataAccess: [
      {
        classification: 'internal',
        dataset: 'campaign_sources',
        reasonKey: 'reason',
        grantedOnInstall: false,
      },
    ],
    tools: ['documents.draft.create', 'email.send'],
    connectors: ['email_smtp'],
  },
  strings: {
    en: Object.fromEntries(
      [
        'title',
        'summary',
        'guardrail',
        'campaign',
        'name',
        'notes',
        'campaigns',
        'skill',
        'skill_steps',
        'workflow',
        'draft',
        'approve',
        'send',
        'reason',
        'expect_good',
        'expect_denied',
      ].map((key) => [key, `Words for ${key}`]),
    ),
  },
  evaluation: [
    {
      id: 'good',
      kind: 'success',
      target: { agent: 'campaign-planner' },
      expectationKey: 'expect_good',
    },
    {
      id: 'denied',
      kind: 'denied',
      target: { workflow: 'campaign_review' },
      expectationKey: 'expect_denied',
    },
  ],
  migrations: [],
};

const rules = (changed: DepartmentPack) => checkDepartmentPack(changed).map(({ rule }) => rule);

describe('the review rules', () => {
  it('pass a pack that follows them', () => {
    expect(checkDepartmentPack(pack)).toEqual([]);
  });

  it.each<[string, (p: DepartmentPack) => DepartmentPack]>([
    ['PACK_ID_FORMAT', (p) => ({ ...p, id: 'Not Valid' })],
    ['PACK_VERSION', (p) => ({ ...p, version: 0 })],
    [
      'OBJECT_NAME_REPEATED',
      (p) => ({ ...p, objects: [...p.objects, p.objects[0] as DepartmentPack['objects'][0]] }),
    ],
    [
      'OBJECT_NO_FIELDS',
      (p) => ({
        ...p,
        objects: [{ ...(p.objects[0] as DepartmentPack['objects'][0]), fields: [] }],
        views: [],
      }),
    ],
    [
      'VIEW_UNKNOWN_OBJECT',
      (p) => ({
        ...p,
        views: [{ ...(p.views[0] as DepartmentPack['views'][0]), object: 'nothing' }],
      }),
    ],
    [
      'VIEW_UNKNOWN_COLUMN',
      (p) => ({
        ...p,
        views: [{ ...(p.views[0] as DepartmentPack['views'][0]), columns: ['nothing'] }],
      }),
    ],
    [
      'AGENT_TOOL_NOT_REQUESTED',
      (p) => ({
        ...p,
        agents: [{ ...agent, tools: { allow: ['documents.search'], deny: ['email.send'] } }],
      }),
    ],
    [
      'AGENT_TOOL_BOTH_ALLOWED_AND_DENIED',
      (p) => ({
        ...p,
        agents: [
          {
            ...agent,
            tools: { allow: ['documents.draft.create'], deny: ['documents.draft.create'] },
          },
        ],
      }),
    ],
    [
      'AGENT_TOOL_HAS_EFFECT',
      (p) => ({
        ...p,
        agents: [{ ...agent, tools: { allow: ['email.send'], deny: ['crm.record.update'] } }],
      }),
    ],
    [
      'AGENT_NO_DENY_LIST',
      (p) => ({ ...p, agents: [{ ...agent, tools: { ...agent.tools, deny: [] } }] }),
    ],
    [
      'AGENT_DELEGATES',
      (p) => ({
        ...p,
        agents: [{ ...agent, execution: { ...agent.execution, max_delegation_depth: 1 } }],
      }),
    ],
    [
      'AGENT_MEMORY_NOT_PROPOSAL',
      (p) => ({
        ...p,
        agents: [
          {
            ...agent,
            context: { ...agent.context, memory_write_policy: 'verified_by_policy' as 'none' },
          },
        ],
      }),
    ],
    [
      'WORKFLOW_UNBOUNDED',
      (p) => ({
        ...p,
        workflows: [
          { ...(p.workflows[0] as DepartmentPack['workflows'][0]), maxIterations: Infinity },
        ],
      }),
    ],
    [
      'WORKFLOW_UNKNOWN_AGENT',
      (p) => ({
        ...p,
        workflows: [
          {
            name: 'other',
            titleKey: 'workflow',
            maxIterations: 1,
            steps: [{ kind: 'agent_task', id: 'x', agent: 'nobody', titleKey: 'draft' }],
          },
        ],
      }),
    ],
    [
      'WORKFLOW_EFFECT_WITHOUT_APPROVAL',
      (p) => ({
        ...p,
        workflows: [
          {
            name: 'other',
            titleKey: 'workflow',
            maxIterations: 1,
            steps: [{ kind: 'side_effect', id: 'x', tool: 'email.send', titleKey: 'send' }],
          },
        ],
      }),
    ],
    [
      'WORKFLOW_TOOL_NOT_REQUESTED',
      (p) => ({
        ...p,
        workflows: [
          {
            name: 'other',
            titleKey: 'workflow',
            maxIterations: 1,
            steps: [
              { kind: 'approval', id: 'a', titleKey: 'approve', approverRole: 'r' },
              { kind: 'side_effect', id: 'x', tool: 'crm.record.update', titleKey: 'send' },
            ],
          },
        ],
      }),
    ],
    [
      'REQUEST_GRANTS_ON_INSTALL',
      (p) => ({
        ...p,
        requests: {
          ...p.requests,
          capabilities: [
            { capability: 'work.create', reasonKey: 'reason', grantedOnInstall: true as false },
          ],
        },
      }),
    ],
    [
      'RESTRICTED_WITHOUT_ISOLATION',
      (p) => ({
        ...p,
        requests: {
          ...p.requests,
          dataAccess: [
            {
              classification: 'restricted',
              dataset: 'employment_records',
              reasonKey: 'reason',
              grantedOnInstall: false,
            },
          ],
        },
      }),
    ],
    [
      'TOOL_MOVES_MONEY',
      (p) => ({ ...p, requests: { ...p.requests, tools: [...p.requests.tools, 'bank.transfer'] } }),
    ],
    [
      'TOOL_MOVES_MONEY',
      (p) => ({
        ...p,
        requests: { ...p.requests, tools: [...p.requests.tools, 'accounting.payment.create'] },
      }),
    ],
    [
      'TOOL_BULK_OUTREACH',
      (p) => ({ ...p, requests: { ...p.requests, tools: [...p.requests.tools, 'email.bulk.send'] } }),
    ],
    [
      'TOOL_NEVER_ALLOWED',
      (p) => ({ ...p, requests: { ...p.requests, tools: [...p.requests.tools, 'secrets.read'] } }),
    ],
    ['STRINGS_NO_ENGLISH', (p) => ({ ...p, strings: { fr: {} } })],
    [
      'STRINGS_MISSING_KEY',
      (p) => ({ ...p, strings: { en: { ...p.strings.en, title: '' } } }),
    ],
    [
      'STRINGS_UNKNOWN_KEY',
      (p) => ({ ...p, strings: { ...p.strings, fr: { nothing_like_this: 'Bonjour' } } }),
    ],
    [
      'STRINGS_COMPLIANCE_CLAIM',
      (p) => ({
        ...p,
        strings: { en: { ...p.strings.en, summary: 'Keeps you compliant with the law.' } },
      }),
    ],
    [
      'EVALUATION_NO_DENIED_SCENARIO',
      (p) => ({ ...p, evaluation: p.evaluation.filter((scenario) => scenario.kind !== 'denied') }),
    ],
    [
      'EVALUATION_AGENT_NOT_COVERED',
      (p) => ({ ...p, evaluation: p.evaluation.filter((scenario) => scenario.kind === 'denied') }),
    ],
    [
      'EVALUATION_UNKNOWN_TARGET',
      (p) => ({
        ...p,
        evaluation: [
          ...p.evaluation,
          {
            id: 'x',
            kind: 'success',
            target: { workflow: 'nothing' },
            expectationKey: 'expect_good',
          },
        ],
      }),
    ],
    [
      'MIGRATION_ON_FIRST_VERSION',
      (p) => ({ ...p, migrations: [{ fromVersion: 0, up: [], rollback: [] }] }),
    ],
    ['MIGRATION_MISSING', (p) => ({ ...p, version: 2 })],
    [
      'MIGRATION_NOT_REVERSIBLE',
      (p) => ({
        ...p,
        version: 2,
        migrations: [
          {
            fromVersion: 1,
            up: [{ kind: 'add_object', object: 'x' }],
            rollback: [],
          },
        ],
      }),
    ],
  ])('catch %s', (rule, change) => {
    expect(rules(change(pack))).toContain(rule);
  });

  it('let a read or a draft be an agent tool', () => {
    const reading = {
      ...pack,
      agents: [
        { ...agent, tools: { allow: ['documents.draft.create'], deny: ['email.send'] } },
      ],
    };
    expect(rules(reading)).not.toContain('AGENT_TOOL_HAS_EFFECT');
  });

  it('use up an approval on the effect after it', () => {
    const twoEffects = {
      ...pack,
      workflows: [
        {
          name: 'other',
          titleKey: 'workflow',
          maxIterations: 1,
          steps: [
            { kind: 'approval', id: 'a', titleKey: 'approve', approverRole: 'r' } as const,
            { kind: 'side_effect', id: 'one', tool: 'email.send', titleKey: 'send' } as const,
            { kind: 'side_effect', id: 'two', tool: 'email.send', titleKey: 'send' } as const,
          ],
        },
      ],
    };
    expect(checkDepartmentPack(twoEffects)).toContainEqual({
      rule: 'WORKFLOW_EFFECT_WITHOUT_APPROVAL',
      subject: 'two',
    });
  });

  it('name the offending key, and never its translated text', () => {
    const claims: DepartmentPack = {
      ...pack,
      strings: { en: { ...pack.strings.en, summary: 'Certified and compliant.' } },
    };
    expect(JSON.stringify(checkDepartmentPack(claims))).not.toContain('Certified');
  });
});

describe('the rollback rules', () => {
  const next = (changes: Partial<DepartmentPack>): DepartmentPack => ({
    ...pack,
    version: 2,
    migrations: [{ fromVersion: 1, up: [], rollback: [] }],
    ...changes,
  });
  const upgrade = (changes: Partial<DepartmentPack>) =>
    checkPackUpgrade(pack, next(changes)).map(({ rule }) => rule);

  it('pass an upgrade that changes nothing risky', () => {
    expect(upgrade({})).toEqual([]);
  });

  it('refuse another pack, or skipping a version', () => {
    expect(upgrade({ id: 'hr_operations' })).toContain('UPGRADE_OTHER_PACK');
    expect(upgrade({ version: 3 })).toContain('UPGRADE_NOT_NEXT_VERSION');
    expect(upgrade({ migrations: [] })).toContain('MIGRATION_MISSING');
  });

  it('refuse dropping an object without archiving it and a way back', () => {
    const dropped = { objects: [], views: [] };
    expect(upgrade(dropped)).toContain('UPGRADE_DROP_NOT_REVERSIBLE');
    expect(
      upgrade({
        ...dropped,
        migrations: [
          {
            fromVersion: 1,
            up: [{ kind: 'drop_object', object: 'campaign', preserve: 'archive' }],
            rollback: [{ kind: 'add_object', object: 'campaign' }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('refuse dropping a field without archiving it and a way back', () => {
    const object = pack.objects[0] as DepartmentPack['objects'][0];
    const fewer = {
      objects: [{ ...object, fields: object.fields.filter((field) => field.name !== 'notes') }],
    };
    expect(upgrade(fewer)).toContain('UPGRADE_DROP_NOT_REVERSIBLE');
    expect(
      upgrade({
        ...fewer,
        migrations: [
          {
            fromVersion: 1,
            up: [{ kind: 'drop_field', object: 'campaign', field: 'notes', preserve: 'archive' }],
            rollback: [{ kind: 'add_field', object: 'campaign', field: 'notes' }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('send anything new it asks for back to a person', () => {
    const asksMore = {
      requests: {
        ...pack.requests,
        capabilities: [
          ...pack.requests.capabilities,
          { capability: 'member.view_email', reasonKey: 'reason', grantedOnInstall: false as const },
        ],
        tools: [...pack.requests.tools, 'crm.record.update'],
      },
    };
    expect(upgrade(asksMore)).toEqual(
      expect.arrayContaining([
        'UPGRADE_NEW_CAPABILITY_WITHOUT_REVIEW',
        'UPGRADE_NEW_TOOL_WITHOUT_REVIEW',
      ]),
    );
    expect(
      upgrade({
        ...asksMore,
        migrations: [
          {
            fromVersion: 1,
            up: [
              { kind: 'request_review', capability: 'member.view_email' },
              { kind: 'request_review', capability: 'crm.record.update' },
            ],
            rollback: [{ kind: 'replace_workflow', workflow: 'campaign_review' }],
          },
        ],
      }),
    ).toEqual([]);
  });
});
