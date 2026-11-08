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
  ],
  message: 'Worker-only: the web tier cannot unseal secrets or act as a service (ADR-024 D5).',
};
const authDatabase = {
  group: ['@ensemus/database/auth'],
  message: 'Only @ensemus/auth may use the auth database role.',
};
const connectorCode = {
  regex: '^@ensemus/connectors(/(?!(manifest|knowledge-manifests)$).*)?$',
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
const testDoubles = {
  group: [
    '@ensemus/connectors/testing',
    '@ensemus/intelligence/testing',
    '@ensemus/knowledge/testing',
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

// Files that are agent-worker's own, so they alone may name the agent database entry.
const agentWorkerFiles = [
  'workers/workflow/src/agent-main.ts',
  'workers/workflow/src/kill-switch.ts',
  'workers/workflow/src/halt-global.ts',
  'packages/workflows/src/agent-activities.ts',
  'packages/workflows/src/model-probe-activities.ts',
  'packages/application/src/ai/runs.ts',
  'packages/application/src/ai/usage.ts',
  'packages/application/src/ai/tool-steps.ts',
  'packages/application/src/ai/delegation.ts',
  'packages/application/src/ai/context-source.ts',
  'packages/application/src/ai/model-probe-store.ts',
];

export default tseslint.config(
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
      '**/migrations/**',
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
    [rawDatabase, authDatabase, agentDatabase],
    ['packages/database/**', 'packages/auth/**', 'tests/**', 'apps/web/**'],
  ),
  restrict(['packages/auth/**/*.ts'], [rawDatabase, temporal, broker, ssoOperator]),
  restrict(['packages/packs/**/*.ts'], [packReach], ['**/*.test.ts']),
  restrict(
    ['apps/web/**/*.{ts,tsx}'],
    [
      rawDatabase,
      authDatabase,
      temporal,
      broker,
      connectorCode,
      agentDatabase,
      agentCodeFromWeb,
      testDoubles,
      knowledgeWorkerCode,
      ssoOperator,
    ],
  ),
  restrict(
    ['workers/**/*.ts', 'packages/workflows/**/*.ts'],
    [rawDatabase, authDatabase, testDoubles, agentDatabase],
    agentWorkerFiles,
  ),
  // Agent code. A rule set on the same files replaces the one before it, so each names everything.
  restrict(
    ['packages/policy/**/*.ts'],
    [rawDatabase, authDatabase, policyReach, aiCore, rawNetworkForModels],
  ),
  restrict(
    ['packages/commercial/**/*.ts'],
    [rawDatabase, authDatabase, agentDatabase, serviceContext],
  ),
  restrict(
    ['packages/application/src/ai/**/*.ts'],
    [rawDatabase, authDatabase, agentDatabase, serviceContext, temporal],
    agentWorkerFiles,
  ),
  restrict(agentWorkerFiles, [rawDatabase, authDatabase, serviceContext, testDoubles]),
  // Fixed terminal metadata/effect adapter only: it constructs no AgentContext and exposes no
  // service context/callback. Its SQL RPC independently requires the actual agent login and an
  // exact terminal run/Work/fence/Temporal/version. Ordinary agent logic stays service-forbidden.
  restrict(
    ['packages/application/src/ai/terminal-work-control.ts'],
    [rawDatabase, authDatabase, agentDatabase, temporal, testDoubles],
  ),
  restrict(
    ['packages/agent-runtime/**/*.ts'],
    [rawDatabase, authDatabase, anyDatabase, serviceContext, temporal, aiCore],
    ['packages/agent-runtime/src/reducer.ts'],
  ),
  restrict(['packages/agent-runtime/src/reducer.ts'], [anything]),
  restrict(
    ['packages/intelligence/**/*.ts'],
    [rawDatabase, authDatabase, anyDatabase, serviceContext, temporal, aiCore, rawNetworkForModels],
    ['packages/intelligence/src/net/**', 'packages/intelligence/src/testing/**'],
  ),
  restrict(
    ['packages/intelligence/src/net/**', 'packages/intelligence/src/testing/**'],
    [rawDatabase, authDatabase, anyDatabase, serviceContext, temporal, aiCore],
  ),
  // The agent's workflow files are workflow code: nothing but the SDK, types and the reducer.
  restrict(
    ['packages/workflows/src/agent-run.ts', 'packages/workflows/src/model-probe.ts'],
    [rawDatabase, authDatabase, agentDatabase, serviceContext, testDoubles],
  ),
  // packages/connectors, in two parts. A rule set on the same files replaces the one before it, so
  // the first has to name everything: its testing folder may use a socket, and network.ts must.
  restrict(
    ['packages/connectors/**/*.ts'],
    [connectorReach, rawNetwork],
    ['packages/connectors/src/runtime/network.ts', 'packages/connectors/src/testing/**'],
  ),
  restrict(
    ['packages/connectors/src/runtime/network.ts', 'packages/connectors/src/testing/**'],
    [connectorReach],
  ),
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
  restrict(['packages/knowledge/**/*.ts'], [knowledgeReach, knowledgeNetwork]),
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
  {
    files: ['tests/**', 'infrastructure/**', 'eslint.config.mjs', '**/scripts/**'],
    rules: { 'no-restricted-properties': 'off' },
  },
);
