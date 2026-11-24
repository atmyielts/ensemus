import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertActivityCapacity,
  CONNECTION_HEADROOM,
  CONNECTOR_ACTIVITY_SLOTS_DEFAULT,
  CONNECTOR_ACTIVITY_SLOTS_MAX,
  CONNECTOR_ACTIVITY_SLOTS_SETTING,
  connectorActivitySlots,
  connectorDatabasePool,
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

describe('the connector worker’s cap on Activities (ADR-027 D5)', () => {
  const slots = (value: string | undefined) =>
    connectorActivitySlots(
      value === undefined ? {} : { [CONNECTOR_ACTIVITY_SLOTS_SETTING]: value },
    );

  it('uses the default when nothing is set, and the default fits its pool', () => {
    expect(slots(undefined)).toBe(CONNECTOR_ACTIVITY_SLOTS_DEFAULT);
    expect(CONNECTOR_ACTIVITY_SLOTS_DEFAULT).toBeLessThan(100);
    expect(() =>
      assertActivityCapacity(
        connectorDatabasePool(CONNECTOR_ACTIVITY_SLOTS_DEFAULT),
        CONNECTOR_ACTIVITY_SLOTS_DEFAULT,
      ),
    ).not.toThrow();
  });

  it.each(['1', '4', '16', String(CONNECTOR_ACTIVITY_SLOTS_MAX)])('takes %s', (value) => {
    expect(slots(value)).toBe(Number(value));
    expect(() =>
      assertActivityCapacity(connectorDatabasePool(Number(value)), Number(value)),
    ).not.toThrow();
  });

  it.each([
    '',
    '0',
    '-1',
    '+4',
    '04',
    '4.5',
    '1e1',
    ' 4',
    '4 ',
    '4\n',
    'eight',
    '0x10',
    String(CONNECTOR_ACTIVITY_SLOTS_MAX + 1),
    '100',
    '9999',
    'CANARYSLOTS',
  ])('refuses %j, naming no value', (value) => {
    let message = '';
    try {
      slots(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('CONNECTOR_ACTIVITY_SLOTS_INVALID');
  });

  it('is what the connector worker is really built with', () => {
    const source = readFileSync(new URL('./connector-worker.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const activitySlots = connectorActivitySlots\(\);/);
    expect(source).toMatch(/assertActivityCapacity\(databasePool,\s*activitySlots\);/);
    expect(source).toMatch(
      /openAppDatabase\(readSecret\('DATABASE_URL_APP'\),\s*\{\s*max:\s*databasePool\s*\}\)/,
    );
    expect(source).toMatch(/maxConcurrentActivityTaskExecutions:\s*activitySlots,/);
    // The cap is read before anything connects, so a bad value never half-starts the worker.
    expect(source.indexOf('connectorActivitySlots()')).toBeLessThan(
      source.indexOf('NativeConnection.connect('),
    );
  });

  it('reaches the connector worker through Compose', () => {
    const compose = readFileSync(
      new URL('../../../infrastructure/compose/compose.yaml', import.meta.url),
      'utf8',
    );
    const service = compose.slice(compose.indexOf('\n  connector-worker:'));
    const block = service.slice(0, service.indexOf('\n\n'));
    expect(block).toContain(
      `${CONNECTOR_ACTIVITY_SLOTS_SETTING}: \${${CONNECTOR_ACTIVITY_SLOTS_SETTING}:-${CONNECTOR_ACTIVITY_SLOTS_DEFAULT}}`,
    );
  });
});
