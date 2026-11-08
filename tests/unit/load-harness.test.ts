import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { summarize, fairness, runProfile } from '../load/harness.mjs';
import { profiles, scenarios } from '../load/profiles.mjs';
import { parseCommand } from '../load/run.mjs';
import { parseSeedCommand } from '../load/seed-fixture.mjs';
import { repoRoot } from '../helpers/stack';

const fixture = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  actors: [
    {
      userId: '22222222-2222-4222-8222-222222222222',
      email: 'load-test@example.invalid',
      cookie: 'test_session=test-generated-secret',
    },
  ],
};
const context = {
  environmentRef: 'test-fixture',
  release: 'test-release',
  networkLocality: 'loopback',
  hardware: { cpuModelRef: 'test-cpu', logicalCpus: 1, memoryBytes: 1024, osRef: 'test-os' },
};
describe('load harness correctness without network or capacity claims', () => {
  it('counts failures and computes nearest-rank percentiles over every attempt', () => {
    expect(
      summarize([
        { durationMs: 10, ok: true },
        { durationMs: 20, ok: false },
        { durationMs: 30, ok: true },
        { durationMs: 40, ok: true },
      ]),
    ).toEqual({ count: 4, p50: 20, p95: 40, p99: 40, errorRate: 0.25 });
    expect(summarize([])).toEqual({ count: 0, p50: null, p95: null, p99: null, errorRate: null });
    expect(() => summarize([{ durationMs: Number.NaN, ok: true }])).toThrow();
  });
  it('reports fairness only when every tenant has usable measurements', () => {
    expect(
      fairness({ a: [{ durationMs: 10, ok: true }], b: [{ durationMs: 20, ok: true }] }),
    ).toEqual({ worstToBestP95Ratio: 2 });
    expect(fairness({ a: [], b: [{ durationMs: 10, ok: true }] })).toEqual({
      worstToBestP95Ratio: null,
    });
  });
  it('refuses an omitted target, a non-generated actor, and a fault scenario without controls', async () => {
    expect(() => parseCommand(['--profile', 'small', '--out', 'test.json'])).toThrow();
    expect(() => parseSeedCommand(['--profile', 'small', '--out', 'test.json'])).toThrow();
    expect(() =>
      parseSeedCommand([
        '--profile',
        'small',
        '--base-url',
        'https://example.invalid',
        '--out',
        'test.json',
      ]),
    ).toThrow('LOOPBACK_TEST_TARGET_REQUIRED');
    const profile = {
      ...profiles.small,
      tenantCount: 1,
      concurrencyPerTenant: 1,
      requestsPerTenant: 2,
    };
    await expect(
      runProfile(profile, { baseUrl: '', tenants: [fixture], generated: true, context }),
    ).rejects.toThrow();
    await expect(
      runProfile(profile, {
        baseUrl: 'https://example.invalid',
        tenants: [{ ...fixture, actors: [{ ...fixture.actors[0], email: 'real@example.com' }] }],
        generated: true,
        context,
      }),
    ).rejects.toThrow();
    await expect(
      runProfile(
        { ...profile, scenario: 'B' },
        { baseUrl: 'https://example.invalid', tenants: [fixture], generated: true, context },
      ),
    ).rejects.toThrow('SCENARIO_CONTROLS_REQUIRED');
  });
  it('uses a fake clock and fetch, counts rejected responses, and omits all tenant content', async () => {
    let now = 0,
      calls = 0;
    const clock = {
      now: () => now,
      monitorDelay: () => () => {},
      fetch: async () => {
        now += 10;
        calls++;
        return new Response('private customer text', {
          status: calls === 1 ? 503 : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const report = await runProfile(
      { ...profiles.small, tenantCount: 1, concurrencyPerTenant: 1, requestsPerTenant: 2 },
      { baseUrl: 'https://example.invalid', tenants: [fixture], generated: true, context },
      clock,
    );
    expect(report.web.count).toBe(2);
    expect(report.web.errorRate).toBe(0.5);
    expect(report.web.p95).toBe(10);
    expect(report.costPerVerifiedOutcome.status).toBe('owed');
    const wire = JSON.stringify(report);
    for (const secret of [
      'private customer text',
      fixture.organizationId,
      fixture.actors[0]!.userId,
      fixture.actors[0]!.email,
      fixture.actors[0]!.cookie,
    ])
      expect(wire).not.toContain(secret);
  });
  it('keeps network failures in the denominator and treats a login HTML response as failure', async () => {
    let now = 0,
      calls = 0;
    const report = await runProfile(
      { ...profiles.small, concurrencyPerTenant: 1, requestsPerTenant: 2 },
      { baseUrl: 'https://example.invalid', tenants: [fixture], generated: true, context },
      {
        now: () => now,
        monitorDelay: () => () => {},
        fetch: async () => {
          now += 5;
          if (++calls === 1) throw new Error('private transport canary');
          return new Response('private login content', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        },
      },
    );
    expect(report.web.count).toBe(2);
    expect(report.web.errorRate).toBe(1);
    expect(report.webTtfb.count).toBe(1);
    expect(JSON.stringify(report)).not.toContain('private');
  });
  it('runs the agent control concurrently and requires measured queue wait and complete proofs', async () => {
    let now = 0,
      active = false,
      release!: () => void;
    const overlapped: boolean[] = [];
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = {
      baseUrl: 'https://example.invalid',
      tenants: [fixture],
      generated: true,
      context,
      controls: {
        exercise: async () => {
          active = true;
          await waiting;
        },
        verify: async () => ({
          conditionInduced: true,
          loadOverlappedReads: true,
          recovered: true,
          isolationVerified: true,
          noDuplicateEffects: true,
          agentQueueWaitMs: [3, 7],
          privateBody: 'private observer text',
        }),
      },
    };
    const report = await runProfile(
      { ...profiles.small, scenario: 'B', concurrencyPerTenant: 1, requestsPerTenant: 2 },
      target,
      {
        now: () => now,
        monitorDelay: () => () => {},
        fetch: async () => {
          overlapped.push(active);
          now += 2;
          release();
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        },
      },
    );
    expect(overlapped).toEqual([true, true]);
    expect(report.web.errorRate).toBe(0);
    expect(report.scenario.verification).toBe('passed');
    expect(report.agentQueueWait.summary?.p95).toBe(7);
    expect(JSON.stringify(report)).not.toContain('private observer text');
  });
  it('preserves the actual currency numerator and rejects an unrelated ledger cohort', async () => {
    const profile = { ...profiles.small, concurrencyPerTenant: 1, requestsPerTenant: 1 },
      clock = {
        now: () => 1,
        monitorDelay: () => () => {},
        fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      };
    const target = {
      baseUrl: 'https://example.invalid',
      tenants: [fixture],
      generated: true,
      context,
      readVerifiedOutcomeCost: async ({ runRef }: { runRef: string }) => ({
        source: 'actual_m4_ledger',
        runRef,
        currency: 'XTS',
        totalCostMicros: '12345678901234567890',
        verifiedOutcomes: 3,
      }),
    };
    expect((await runProfile(profile, target, clock)).costPerVerifiedOutcome).toEqual({
      status: 'measured',
      currency: 'XTS',
      numeratorMicros: '12345678901234567890',
      verifiedOutcomes: 3,
    });
    await expect(
      runProfile(
        profile,
        {
          ...target,
          readVerifiedOutcomeCost: async () => ({
            source: 'actual_m4_ledger',
            runRef: 'different-test-run',
            currency: 'XTS',
            totalCostMicros: '1',
            verifiedOutcomes: 1,
          }),
        },
        clock,
      ),
    ).rejects.toThrow('LEDGER_COST_BASIS_INVALID');
  });
  it('defines A–L explicitly, keeps persona values as parameters, and parses every scaling template', () => {
    expect(Object.keys(scenarios)).toEqual('ABCDEFGHIJKL'.split(''));
    expect(Object.keys(profiles)).toEqual(['small', 'medium', 'growing', 'multiTenantAggregate']);
    for (const profile of Object.values(profiles)) {
      expect(profile.kind).toBe('test-persona');
      expect(profile.requestsPerTenant).toBeGreaterThan(0);
      expect(profile.retentionDays).toBeNull();
    }
    const root = join(repoRoot, 'infrastructure/autoscaling');
    for (const file of readdirSync(root).filter((name) => name.endsWith('.yaml'))) {
      const manifest = parse(readFileSync(join(root, file), 'utf8')) as {
        activation: string;
        workloads: {
          name: string;
          signal: { binding: string };
          limits: { maxReplicas: number | null };
        }[];
      };
      expect(manifest.activation).toBe('template-only');
      expect(manifest.workloads.map((workload) => workload.name)).toEqual([
        'web',
        'platform-worker',
        'agent-worker',
        'connector-worker',
        'dispatcher',
      ]);
      for (const workload of manifest.workloads) {
        expect(workload.signal.binding).toMatch(/^[a-z_.-]+$/);
        expect(workload.limits.maxReplicas).toBeNull();
      }
    }
  });
});
