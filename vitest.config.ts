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
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
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
