// A shared-host deployment must reserve headroom outside Go and bound its caches by bytes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const compose = parse(readFileSync('infrastructure/compose/compose.yaml', 'utf8'));
const dynamic = parse(readFileSync('infrastructure/compose/temporal/dynamicconfig.yaml', 'utf8'));
const server = compose.services.temporal;
const mib = 1024 * 1024;
// These expressions also require that operators can override each documented Compose default.
const goMiB = Number(
  /\$\{ENSEMUS_TEMPORAL_GO_MEMORY_LIMIT:-([0-9]+)MiB\}/.exec(server.environment.GOMEMLIMIT)?.[1],
);
const containerMiB = Number(
  /\$\{ENSEMUS_TEMPORAL_MEMORY_LIMIT:-([0-9]+)M\}/.exec(
    server.deploy?.resources?.limits?.memory,
  )?.[1],
);

describe('the all-in-one Temporal memory budget', () => {
  it('leaves native and stack headroom below an explicit container ceiling', () => {
    expect(goMiB).toBeGreaterThan(0);
    expect(containerMiB).toBeLessThanOrEqual(1024);
    expect(containerMiB).toBeGreaterThanOrEqual(goMiB * 1.25);
  });

  it('uses host-wide byte caches that fit inside one quarter of the Go target', () => {
    expect(dynamic['history.cacheSizeBasedLimit']).toEqual([{ value: true }]);
    expect(dynamic['history.enableHostLevelEventsCache']).toEqual([{ value: true }]);
    const caches = [
      'history.hostLevelCacheMaxSizeBytes',
      'history.eventsHostLevelCacheMaxSizeBytes',
    ].map((key) => dynamic[key][0].value as number);
    for (const bytes of caches) {
      expect(Number.isSafeInteger(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
    }
    expect(caches.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual((goMiB * mib) / 4);
  });
});
