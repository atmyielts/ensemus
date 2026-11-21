// Import boundaries are architecture rules (ADR-015, ADR-016, ADR-020, ADR-024), so they fail the build.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const restrict = (files, patterns, ignores = []) => ({
  files,
  ignores,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

const rawDatabase = {
  group: ['pg', 'pg/*', 'drizzle-orm/node-postgres', 'drizzle-orm/node-postgres/*'],
  message: 'Only @ensemus/database may open connections. Use withTenantTx (ADR-024 D4).',
};
const temporal = {
  group: ['@temporalio/*', '@ensemus/workflows', '@ensemus/workflows/*'],
  message: 'The web tier has no Temporal path. Commit to the outbox instead (ADR-024 D3).',
};
const broker = {
  group: [
    '@ensemus/secrets/broker',
    '@ensemus/database/secrets',
    '@ensemus/database/service',
    '@ensemus/database/dispatcher',
    '@ensemus/database/setup-token',
    '@ensemus/database/account',
    '@ensemus/database/payment-routing',
    '@ensemus/database/operator',
    '@ensemus/database/support',
    '@ensemus/database/eraser',
    '@ensemus/application/saas/operator-*',
    '@ensemus/application/saas/support-desk',
  ],
  message: 'Worker-only: the web tier cannot unseal secrets or act as a service (ADR-024 D5).',
};
const accountTx = {
  group: ['@ensemus/database/account'],
  message:
    'Only @ensemus/application/saas may write in a tenant that is not served in full (ADR-032 D5).',
};
const operatorRoles = {
  group: ['@ensemus/database/operator', '@ensemus/database/support', '@ensemus/database/eraser'],
  message:
    'These roles belong to the operator commands in workers/workflow/src/ops*.ts (ADR-032 D3).',
};
const saasReach = {
  group: [
    '@ensemus/application',
    '@ensemus/application/*',
    '@ensemus/connectors',
    '@ensemus/connectors/*',
    '@ensemus/contracts',
    '@ensemus/database',
    '@ensemus/database/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ensemus/workflows',
    '@ensemus/workflows/*',
    '@temporalio/*',
    'drizzle-orm',
    'drizzle-orm/*',
    'next',
    'next/*',
    'pg',
    'pg/*',
    'net',
    'node:net',
    'http',
    'node:http',
    'https',
    'node:https',
    'node:fs',
    'fs',
  ],
  message: '@ensemus/saas is pure: no database, network or framework (ADR-032 D1).',
};
const authDatabase = {
  group: ['@ensemus/database/auth'],
  message: 'Only @ensemus/auth may use the auth database role.',
};
const bridge = {
  group: ['@ensemus/database/federation'],
  message:
    'The one role that crosses tenants belongs to the federation worker alone (ADR-035 D2). Everything else stays in its tenant.',
};
const deployJobs = {
  group: ['@ensemus/database/deployment'],
  message: 'Only deploy jobs may change what a deployment is (ADR-035 D5).',
};
const connectorCode = {
  regex: '^@ensemus/connectors(/(?!(manifest|knowledge-manifests|manifest-business)$).*)?$',
  message:
    'Connectors run in the connector worker. The web tier may read manifests only (ADR-027).',
};
const ssoOperator = {
  group: ['@ensemus/database/sso-operator'],
  message:
    'The operator verifies a domain from the command line. No tenant path reaches this (ADR-031 D9).',
};
const packReach = {
  regex: '^(?!@ensemus/domain/)(@ensemus/|pg|drizzle-orm|@temporalio/|better-auth|node:)',
  message: 'A pack is data. It proposes things and reaches nothing (ADR-031 D10).',
};
const vendorIssuer = {
  group: ['@ensemus/sovereign/issuer', '@ensemus/sovereign/testing'],
  message: 'The issuing tool and its test keys are the vendor side and never ship (ADR-030 D3).',
};
const webOffSovereignTools = {
  group: [
    '@ensemus/sovereign/bundle',
    '@ensemus/sovereign/backup',
    '@ensemus/sovereign/diagnostics',
    '@ensemus/sovereign/sealed',
    '@ensemus/sovereign/tar',
  ],
  message:
    'Operator tools run in operator commands. The web tier checks signatures only (ADR-030).',
};
const sovereignReach = {
  group: [
    '@ensemus/application',
    '@ensemus/application/*',
    '@ensemus/connectors',
    '@ensemus/connectors/*',
    '@ensemus/database',
    '@ensemus/database/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ensemus/storage',
    '@ensemus/storage/*',
    '@ensemus/workflows',
    '@ensemus/workflows/*',
    '@temporalio/*',
    'drizzle-orm',
    'drizzle-orm/*',
    'pg',
    'pg/*',
  ],
  message:
    'This package has to run alone on an isolated machine, so it reaches only the domain (ADR-030 D4).',
};
const testDoubles = {
  group: [
    '@ensemus/connectors/testing',
    '@ensemus/skills/testing',
    '@ensemus/skills/sign',
    '@ensemus/sandbox/testing',
    '@ensemus/department-packs/testing',
    '@ensemus/intelligence/testing',
    '@ensemus/knowledge/testing',
    '@ensemus/sovereign/testing',
    '@ensemus/saas/testing',
  ],
  message: 'Test doubles never reach a shipped image.',
};
const knowledgeWorkerCode = {
  group: [
    '@ensemus/application/knowledge/ingest',
    '@ensemus/application/knowledge/embeddings',
    '@ensemus/knowledge/parsing',
    '@ensemus/knowledge/chunking',
    '@ensemus/knowledge/prompt',
    '@ensemus/knowledge/egress-simulation',
  ],
  message:
    'Parsing and model calls run in workers. The web tier reads and enqueues (ADR-029 D4, D5).',
};
const knowledgeReach = {
  group: [
    '@ensemus/application',
    '@ensemus/application/*',
    '@ensemus/connectors',
    '@ensemus/connectors/*',
    '@ensemus/database',
    '@ensemus/database/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ensemus/storage',
    '@ensemus/workflows',
    '@ensemus/workflows/*',
    '@temporalio/*',
    'drizzle-orm',
    'drizzle-orm/*',
    'pg',
    'pg/*',
  ],
  message: '@ensemus/knowledge is pure rules and ports. Whatever it needs is passed in (ADR-029).',
};
const knowledgeNetwork = {
  group: [
    'net',
    'node:net',
    'tls',
    'node:tls',
    'http',
    'node:http',
    'https',
    'node:https',
    'http2',
    'node:http2',
    'dgram',
    'node:dgram',
    'dns',
    'node:dns',
    'child_process',
    'node:child_process',
  ],
  message: 'Nothing in @ensemus/knowledge can reach a network or a process (ADR-029).',
};
const operatorDatabase = {
  group: ['@ensemus/database/marketplace-operator'],
  message: 'Only the marketplace operator command may use its role (ADR-034 D6).',
};
const webSkillCode = {
  group: ['@ensemus/sandbox', '@ensemus/sandbox/*', '@ensemus/skills', '@ensemus/skills/*'],
  message: 'The web tier stores bytes and parses nothing. A worker checks a bundle (ADR-034 D2).',
};
const sandboxReach = {
  group: [
    '@ensemus/application',
    '@ensemus/application/*',
    '@ensemus/auth',
    '@ensemus/auth/*',
    '@ensemus/config',
    '@ensemus/connectors',
    '@ensemus/connectors/*',
    '@ensemus/database',
    '@ensemus/database/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ensemus/storage',
    '@ensemus/workflows',
    '@ensemus/workflows/*',
    '@temporalio/*',
    'drizzle-orm',
    'drizzle-orm/*',
    'pg',
    'pg/*',
  ],
  message: 'The sandbox package holds no credential and reaches no store (ADR-034 D3).',
};
const skillReach = {
  group: [...sandboxReach.group, '@ensemus/sandbox', '@ensemus/sandbox/*'],
  message: 'Reading a bundle needs no store and no credential (ADR-034 D2).',
};
const sandboxWorkerReach = {
  group: [
    '@ensemus/connectors',
    '@ensemus/connectors/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ensemus/database/secrets',
    '@ensemus/database/service',
    '@ensemus/database/dispatcher',
    '@ensemus/database/setup-token',
  ],
  message: 'The sandbox worker holds no broker and no connector, so it has nothing to give away.',
};
const runnerReach = {
  group: [
    ...sandboxReach.group.filter((pattern) => pattern !== '@ensemus/config'),
    '@ensemus/skills',
    '@ensemus/skills/*',
  ],
  message: 'The runner holds no database and no credential. It only starts jobs (ADR-034 D3).',
};
const connectorReach = {
  group: [
    '@ensemus/application',
    '@ensemus/application/*',
    '@ensemus/database',
    '@ensemus/database/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ensemus/workflows',
    '@ensemus/workflows/*',
    '@temporalio/*',
    'drizzle-orm',
    'drizzle-orm/*',
    'pg',
    'pg/*',
  ],
  message:
    'A connector gets a lease and a gateway from its context, and nothing else (ADR-027 D3).',
};
const rawNetwork = {
  group: [
    'net',
    'node:net',
    'http',
    'node:http',
    'https',
    'node:https',
    'http2',
    'node:http2',
    'dgram',
    'node:dgram',
    'dns',
    'node:dns',
  ],
  message:
    'A connector goes out only through ConnectorNetwork, to the egress gateway (ADR-027 D5).',
};

// Governed AI (ADR-028). Only agent-worker's code may open the agent role or reach a model.
const agentDatabase = {
  group: ['@ensemus/database/agent', '@ensemus/database/halt-operator'],
  message: 'Agent-worker only: this role can read prompts and write usage (ADR-028 FD-4).',
};
const agentCodeFromWeb = {
  group: [
    '@ensemus/intelligence',
    '@ensemus/intelligence/*',
    '@ensemus/agent-runtime',
    '@ensemus/agent-runtime/*',
    '@ensemus/application/ai-usage',
    '@ensemus/application/ai-runs',
    '@ensemus/application/ai-tool-steps',
    '@ensemus/application/ai-delegation',
    '@ensemus/application/ai-context-source',
    '@ensemus/application/ai-input-ledger',
    '@ensemus/application/ai-model-admission',
    '@ensemus/application/ai-external-action-port',
    '@ensemus/application/ai-model-probe-store',
    '@ensemus/application/ai-knowledge-call-store',
    '@ensemus/application/ai-knowledge-result-consumer',
    '@ensemus/application/ai-knowledge-model-jobs',
    '@ensemus/application/ai-knowledge-job-content',
  ],
  message: 'The web tier starts and shows runs. It never runs one, and has no key (ADR-028 FD-2).',
};
const serviceContext = {
  group: ['@ensemus/database/service'],
  message:
    'An agent acts as its initiator through createAgentContext. A service context skips every Work Unit check (ADR-028 FD-3).',
};
const anyDatabase = {
  group: ['@ensemus/database', '@ensemus/database/*', 'drizzle-orm', 'drizzle-orm/*'],
  message:
    'No database here. Name what you need in @ensemus/application/ai-ports, so a model call can never sit inside a transaction (ADR-028).',
};
const aiCore = {
  regex: '^(ai(/.*)?|@ai-sdk/gateway(/.*)?)$',
  message:
    'Provider packages only. The core retries by default, and a bare model string can resolve to a hosted gateway (ADR-028 FD-11).',
};
const policyReach = {
  group: [
    '@ensemus/application',
    '@ensemus/application/*',
    '@ensemus/database',
    '@ensemus/database/*',
    '@ensemus/intelligence',
    '@ensemus/intelligence/*',
    '@ensemus/agent-runtime',
    '@ensemus/agent-runtime/*',
    '@ensemus/secrets',
    '@ensemus/secrets/*',
    '@ai-sdk/*',
    'undici',
    'drizzle-orm',
    'drizzle-orm/*',
    '@temporalio/*',
  ],
  message: 'Policy is pure: no database, SDK or network, and it never asks a model (ADR-012).',
};
const anything = {
  regex: '.*',
  message:
    'The reducer imports nothing, so the workflow sandbox can load it and tests reach it all.',
};
const rawNetworkForModels = {
  regex: '^((node:)?(net|http|https|http2|dgram|dns|tls)|undici)$',
  message: 'A model call goes out only through the guarded fetch in src/net (ADR-028 FD-10).',
};

// Platform email. The mailer role reads every tenant's member names and addresses (0571), so only the
// mail worker's own files may open it.
const mailerDatabase = {
  group: ['@ensemus/database/mailer'],
  message: 'Mail-worker only: this role reads every tenant member address (0571).',
};
const mailWorkerFiles = [
  'workers/workflow/src/mail-worker.ts',
  'workers/workflow/src/mail/**/*.ts',
];

// Files that are agent-worker's own, so they alone may name the agent database entry.
const agentWorkerFiles = [
  'workers/workflow/src/agent-main.ts',
  'workers/workflow/src/kill-switch.ts',
  'workers/workflow/src/halt-global.ts',
  // Restore reconciliation fences and purges private transcripts through the agent role (ADR-026).
  'workers/workflow/src/restore-reconcile.ts',
  'packages/workflows/src/agent-activities.ts',
  'packages/workflows/src/model-probe-activities.ts',
  'packages/application/src/ai/runs.ts',
  'packages/application/src/ai/usage.ts',
  'packages/application/src/ai/tool-steps.ts',
  'packages/application/src/ai/delegation.ts',
  'packages/application/src/ai/context-source.ts',
  'packages/application/src/ai/model-probe-store.ts',
];

const saasBoundarySelectors = [
  {
    selector: "ImportDeclaration[source.value='@ensemus/database/account']",
    message: accountTx.message,
  },
  ...operatorRoles.group.map((name) => ({
    selector: `ImportDeclaration[source.value='${name}']`,
    message: operatorRoles.message,
  })),
];

const BRIDGE_FILES = [
  'workers/workflow/src/federation-worker.ts',
  'packages/workflows/src/federation-activities.ts',
  'packages/workflows/src/federation-deps.ts',
];
const DEPLOY_JOB_FILES = [
  'workers/workflow/src/apply-deployment-profile.ts',
  'workers/workflow/src/isolation-report.ts',
];

export default tseslint.config(
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/database/**', 'tests/**', 'workers/workflow/src/auth-restore.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value="@ensemus/database/auth-restore-operator"]',
          message:
            'Restore admission is an offline migrator command, never a product/runtime capability.',
        },
        {
          selector: 'ImportDeclaration[source.value="@ensemus/auth/restore"]',
          message: 'Native key recovery is only the dedicated offline auth-restore command.',
        },
      ],
    },
  },
  {
    ignores: [
      'docs/**',
      '.claude/**',
      '.local/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/generated/**',
      '**/next-env.d.ts',
      'packages/database/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'console', property: 'log', message: 'Use the redacting logger.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.property.name='env'][property.name=/^NEXT_PUBLIC_/]",
          message: 'NEXT_PUBLIC_ values are public. None are approved yet.',
        },
      ],
    },
  },
  restrict(
    ['**/*.{ts,tsx}'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      agentDatabase,
      mailerDatabase,
      operatorDatabase,
    ],
    ['packages/database/**', 'packages/auth/**', 'tests/**', 'apps/web/**'],
  ),
  restrict(['packages/auth/**/*.ts'], [rawDatabase, temporal, broker, ssoOperator, vendorIssuer]),
  restrict(
    ['packages/packs/**/*.ts'],
    [packReach],
    ['**/*.test.ts', 'packages/packs/src/index.ts'],
  ),
  // The catalog may aggregate the other data-only pack package. Its suppliers keep packReach.
  restrict(
    ['packages/packs/src/index.ts'],
    [
      {
        ...packReach,
        regex:
          '^(?!@ensemus/domain/|@ensemus/department-packs$)(@ensemus/|pg|drizzle-orm|@temporalio/|better-auth|node:)',
      },
    ],
  ),
  restrict(
    ['apps/web/**/*.{ts,tsx}'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      temporal,
      broker,
      vendorIssuer,
      webOffSovereignTools,
      connectorCode,
      operatorDatabase,
      webSkillCode,
      agentDatabase,
      agentCodeFromWeb,
      testDoubles,
      knowledgeWorkerCode,
      ssoOperator,
      mailerDatabase,
    ],
  ),
  restrict(
    ['workers/**/*.ts', 'packages/workflows/**/*.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      testDoubles,
      agentDatabase,
      mailerDatabase,
      operatorDatabase,
    ],
    [...agentWorkerFiles, ...mailWorkerFiles],
  ),
  restrict(mailWorkerFiles, [
    rawDatabase,
    authDatabase,
    bridge,
    deployJobs,
    vendorIssuer,
    testDoubles,
    agentDatabase,
  ]),
  // Agent code. A rule set on the same files replaces the one before it, so each names everything.
  restrict(
    ['packages/policy/**/*.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      policyReach,
      aiCore,
      rawNetworkForModels,
    ],
  ),
  restrict(
    ['packages/commercial/**/*.ts'],
    [rawDatabase, authDatabase, bridge, deployJobs, vendorIssuer, agentDatabase, serviceContext],
  ),
  restrict(
    ['packages/application/src/ai/**/*.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      agentDatabase,
      serviceContext,
      temporal,
    ],
    agentWorkerFiles,
  ),
  restrict(agentWorkerFiles, [
    rawDatabase,
    authDatabase,
    vendorIssuer,
    serviceContext,
    testDoubles,
  ]),
  // Fixed terminal metadata/effect adapter only: it constructs no AgentContext and exposes no
  // service context/callback. Its SQL RPC independently requires the actual agent login and an
  // exact terminal run/Work/fence/Temporal/version. Ordinary agent logic stays service-forbidden.
  restrict(
    ['packages/application/src/ai/terminal-work-control.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      agentDatabase,
      temporal,
      testDoubles,
    ],
  ),
  restrict(
    ['packages/agent-runtime/**/*.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      anyDatabase,
      serviceContext,
      temporal,
      aiCore,
    ],
    ['packages/agent-runtime/src/reducer.ts'],
  ),
  restrict(['packages/agent-runtime/src/reducer.ts'], [anything]),
  restrict(
    ['packages/intelligence/**/*.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      anyDatabase,
      serviceContext,
      temporal,
      aiCore,
      rawNetworkForModels,
    ],
    ['packages/intelligence/src/net/**', 'packages/intelligence/src/testing/**'],
  ),
  restrict(
    ['packages/intelligence/src/net/**', 'packages/intelligence/src/testing/**'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      anyDatabase,
      serviceContext,
      temporal,
      aiCore,
    ],
  ),
  // The agent's workflow files are workflow code: nothing but the SDK, types and the reducer.
  restrict(
    ['packages/workflows/src/agent-run.ts', 'packages/workflows/src/model-probe.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      agentDatabase,
      serviceContext,
      testDoubles,
    ],
  ),
  // packages/connectors, in two parts. A rule set on the same files replaces the one before it, so
  // the first has to name everything: its testing folder may use a socket, and network.ts must.
  restrict(
    ['packages/connectors/**/*.ts'],
    [connectorReach, rawNetwork, vendorIssuer],
    ['packages/connectors/src/runtime/network.ts', 'packages/connectors/src/testing/**'],
  ),
  restrict(
    ['packages/connectors/src/runtime/network.ts', 'packages/connectors/src/testing/**'],
    [connectorReach, vendorIssuer],
  ),
  restrict(['packages/department-packs/**/*.ts'], [packReach]),
  {
    files: ['packages/department-packs/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'A department pack is plain data, and reaches nothing.' },
      ],
    },
  },
  {
    files: ['packages/connectors/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'A connector goes out only through ConnectorNetwork (ADR-027 D5).',
        },
      ],
    },
  },
  restrict(['packages/knowledge/**/*.ts'], [knowledgeReach, knowledgeNetwork, vendorIssuer]),
  {
    files: ['packages/knowledge/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Nothing in @ensemus/knowledge can reach a network (ADR-029).' },
      ],
    },
  },
  {
    files: ['packages/intelligence/**/*.ts'],
    ignores: [
      'packages/intelligence/src/net/**',
      'packages/intelligence/src/testing/**',
      '**/*.test.ts',
      '**/*.test-support.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'A model call uses the guarded fetch it was handed (ADR-028 FD-10).',
        },
      ],
    },
  },
  // Sovereign/operator tools preserve their standalone no-network/no-runtime boundary (ADR-030).
  restrict(
    ['packages/sovereign/**/*.ts', 'workers/workflow/src/tools/**/*.ts'],
    [sovereignReach, rawNetwork, rawDatabase, authDatabase, vendorIssuer],
  ),
  {
    files: ['packages/sovereign/**/*.ts', 'workers/workflow/src/tools/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Nothing in the Sovereign tools may reach a network (ADR-030 D4).',
        },
      ],
    },
  },
  {
    files: ['tests/**', 'infrastructure/**', 'eslint.config.mjs', '**/scripts/**'],
    rules: { 'no-restricted-properties': 'off' },
  },
  restrict(['packages/saas/**/*.ts'], [saasReach], ['packages/saas/src/testing/**']),
  {
    files: [
      'apps/web/**/*.{ts,tsx}',
      'packages/application/src/**/*.ts',
      'packages/workflows/**/*.ts',
      'workers/**/*.ts',
    ],
    ignores: ['packages/application/src/saas/**', 'workers/workflow/src/ops*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...saasBoundarySelectors] },
  },
  // M11B. Later rule sets replace earlier ones on the same files, so each names everything it means.
  restrict(
    ['workers/workflow/src/marketplace-operator.ts', 'workers/workflow/src/marketplace-command.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      testDoubles,
      agentDatabase,
      mailerDatabase,
    ],
  ),
  restrict(
    ['workers/workflow/src/sandbox-worker.ts', 'packages/workflows/src/sandbox-run-activities.ts'],
    [
      rawDatabase,
      authDatabase,
      bridge,
      deployJobs,
      vendorIssuer,
      testDoubles,
      agentDatabase,
      mailerDatabase,
      operatorDatabase,
      sandboxWorkerReach,
    ],
  ),
  restrict(['workers/workflow/src/sandbox-runner.ts'], [rawDatabase, runnerReach, testDoubles]),
  restrict(
    ['packages/sandbox/**/*.ts'],
    [
      sandboxReach,
      { group: ['@ensemus/skills', '@ensemus/skills/*'], message: 'A job is only bytes.' },
    ],
  ),
  restrict(
    ['packages/skills/**/*.ts'],
    [
      skillReach,
      rawNetwork,
      { group: ['node:child_process', 'child_process'], message: 'Reading a bundle runs nothing.' },
    ],
  ),
  restrict(BRIDGE_FILES, [
    rawDatabase,
    authDatabase,
    vendorIssuer,
    testDoubles,
    agentDatabase,
    mailerDatabase,
    operatorDatabase,
    deployJobs,
  ]),
  restrict(DEPLOY_JOB_FILES, [
    rawDatabase,
    authDatabase,
    vendorIssuer,
    testDoubles,
    agentDatabase,
    mailerDatabase,
    operatorDatabase,
    bridge,
  ]),
);
