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
  regex: '^@ensemus/connectors(/(?!manifest$).*)?$',
  message:
    'Connectors run in the connector worker. The web tier may read manifests only (ADR-027).',
};
const testDoubles = {
  group: [
    '@ensemus/connectors/testing',
    '@ensemus/skills/testing',
    '@ensemus/skills/sign',
    '@ensemus/sandbox/testing',
  ],
  message: 'Test doubles and signing never reach a shipped image (ADR-034 D2).',
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

export default tseslint.config(
  {
    ignores: [
      'docs/**',
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
    [rawDatabase, authDatabase, operatorDatabase],
    ['packages/database/**', 'packages/auth/**', 'tests/**', 'apps/web/**'],
  ),
  restrict(['packages/auth/**/*.ts'], [rawDatabase, temporal, broker]),
  restrict(
    ['apps/web/**/*.{ts,tsx}'],
    [rawDatabase, authDatabase, temporal, broker, connectorCode, operatorDatabase, webSkillCode],
  ),
  restrict(
    ['workers/**/*.ts', 'packages/workflows/**/*.ts'],
    [rawDatabase, authDatabase, testDoubles, operatorDatabase],
  ),
  // M11B. Later rule sets replace earlier ones on the same files, so each names everything it means.
  restrict(
    ['workers/workflow/src/marketplace-operator.ts', 'workers/workflow/src/marketplace-command.ts'],
    [rawDatabase, authDatabase, testDoubles],
  ),
  restrict(
    ['workers/workflow/src/sandbox-worker.ts', 'packages/workflows/src/sandbox-run-activities.ts'],
    [rawDatabase, authDatabase, testDoubles, operatorDatabase, sandboxWorkerReach],
  ),
  restrict(['workers/workflow/src/sandbox-runner.ts'], [rawDatabase, runnerReach, testDoubles]),
  restrict(
    ['packages/sandbox/**/*.ts'],
    [sandboxReach, { group: ['@ensemus/skills', '@ensemus/skills/*'], message: 'A job is only bytes.' }],
  ),
  restrict(
    ['packages/skills/**/*.ts'],
    [skillReach, rawNetwork, { group: ['node:child_process', 'child_process'], message: 'Reading a bundle runs nothing.' }],
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
  {
    files: ['tests/**', 'infrastructure/**', 'eslint.config.mjs', '**/scripts/**'],
    rules: { 'no-restricted-properties': 'off' },
  },
);
