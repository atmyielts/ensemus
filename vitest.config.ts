import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/src/**/*.test.ts',
            'workers/**/src/**/*.test.ts',
            'tests/unit/**/*.test.ts',
            // Shared suites a real implementation and its double both pass, and evaluation over a
            // scripted model, which proves the harness and the gates and not any model (ADR-028).
            'tests/contract/**/*.test.ts',
            'tests/eval/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          // Red-team cases at the gateway level use the same database (ADR-028).
          include: ['tests/integration/**/*.test.ts', 'tests/security/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'replay',
          include: ['tests/replay/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
      // An in-process worker on a real Temporal server. CI gets a gate for this when containers do.
      {
        test: {
          name: 'temporal',
          include: ['tests/temporal/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'measure',
          include: ['tests/measure/**/*.measure.ts'],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'stack',
          include: ['tests/stack/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
