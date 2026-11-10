import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertActivityCapacity,
  CONNECTION_HEADROOM,
  PLATFORM_ACTIVITY_SLOTS,
  PLATFORM_DATABASE_POOL,
} from './worker-limits';

describe('the platform worker’s Activities against its database pool (WORK-06)', () => {
  it('runs fewer Activities at once than it has connections, with headroom', () => {
    expect(() =>
      assertActivityCapacity(PLATFORM_DATABASE_POOL, PLATFORM_ACTIVITY_SLOTS),
    ).not.toThrow();
    expect(PLATFORM_ACTIVITY_SLOTS + CONNECTION_HEADROOM).toBeLessThanOrEqual(
      PLATFORM_DATABASE_POOL,
    );
  });

  it('refuses the SDK default of 100 Activities on a pool of 10, and any other overcommit', () => {
    expect(() => assertActivityCapacity(10, 100)).toThrow('WORKER_CAPACITY_EXCEEDS_POOL');
    expect(() => assertActivityCapacity(10, 9)).toThrow('WORKER_CAPACITY_EXCEEDS_POOL');
    expect(() => assertActivityCapacity(10, 0)).toThrow('WORKER_CAPACITY_INVALID');
    expect(() => assertActivityCapacity(Number.NaN, 1)).toThrow('WORKER_CAPACITY_INVALID');
  });

  it('is what the platform worker is really built with', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(
      /openAppDatabase\(readSecret\('DATABASE_URL_APP'\),\s*\{\s*max:\s*PLATFORM_DATABASE_POOL,?\s*\}\)/,
    );
    expect(main).toMatch(/maxConcurrentActivityTaskExecutions:\s*PLATFORM_ACTIVITY_SLOTS,/);
    expect(main).toMatch(
      /assertActivityCapacity\(PLATFORM_DATABASE_POOL,\s*PLATFORM_ACTIVITY_SLOTS\);/,
    );
  });
});
