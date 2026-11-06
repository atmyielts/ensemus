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
  group: ['@ensemus/connectors/testing', '@ensemus/saas/testing'],
  message: 'Test doubles never reach a shipped image.',
};
// Rules over money and retention. They take facts and answer, so they are testable and cannot reach anything.
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
    [rawDatabase, authDatabase],
    ['packages/database/**', 'packages/auth/**', 'tests/**', 'apps/web/**'],
  ),
  restrict(['packages/auth/**/*.ts'], [rawDatabase, temporal, broker]),
  restrict(
    ['apps/web/**/*.{ts,tsx}'],
    [rawDatabase, authDatabase, temporal, broker, connectorCode, testDoubles],
  ),
  restrict(
    ['workers/**/*.ts', 'packages/workflows/**/*.ts'],
    [rawDatabase, authDatabase, testDoubles, accountTx, operatorRoles],
    ['workers/workflow/src/ops*.ts'],
  ),
  restrict(['workers/workflow/src/ops*.ts'], [rawDatabase, authDatabase, testDoubles, accountTx]),
  // The application layer, where only billing, lifecycle and support may write outside full service.
  restrict(
    ['packages/application/src/**/*.ts'],
    [rawDatabase, authDatabase, accountTx, operatorRoles],
    ['packages/application/src/saas/**'],
  ),
  restrict(['packages/saas/**/*.ts'], [saasReach], ['packages/saas/src/testing/**']),
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
