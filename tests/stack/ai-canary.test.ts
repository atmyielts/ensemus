// SEC-02 / SEC-04, ADR-024 acceptance row 3 and ADR-028 assurance. This is a real built-stack gate,
// not an in-memory scan: HTTP start -> outbox -> Temporal -> agent-worker -> private fake -> tool.
// No Docker is started here. Opt in with ENSEMUS_AI_ENABLED=true on an already running test stack.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import { FEATURE_AGENT_RUN, FEATURE_MODEL_CALL } from '@ensemus/commercial';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdsEncodedCanary, scanCanarySurfaces } from '../../evaluations/safety/canary-scan';
import { BASE } from '../helpers/forms';
import { seedBillingAccount, seedPlan, seedRateCard } from '../helpers/saas';
import { api } from '../helpers/slice-2';
import { compose, secret } from '../helpers/stack';
import { MODEL_ORIGIN, startAiCanaryRun } from '../security/m4-stack-fixture';

const here = dirname(fileURLToPath(import.meta.url));
const poll = { timeout: 90000, interval: 500 };
const marker = () => `M4STACKCANARY${randomUUID().replaceAll('-', '')}`;
const dumpTemporal = () =>
  ['temporal', 'temporal_visibility']
    .map((database) => compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', database))
    .join('\n');
const enabled = process.env.ENSEMUS_AI_ENABLED === 'true';
/** The air-gap gate's hosted phase gives this process the deployment's own settings (air-gap-gate.mjs HOSTED). */
const HOSTED =
  (process.env.ENSEMUS_MODE ?? 'sovereign') !== 'sovereign' &&
  process.env.ENSEMUS_BILLING_ENABLED === 'true';
const temporalAddress = `127.0.0.1:${process.env.ENSEMUS_TEST_TEMPORAL_PORT ?? '57233'}`;

describe.skipIf(!enabled)('M4 real agent-run confidentiality', () => {
  let connection: Connection;
  let temporal: Client;
  const fixtures: Awaited<ReturnType<typeof startAiCanaryRun>>[] = [];
  const protectedMarkers: { id: string; value: string }[] = [];

  beforeAll(async () => {
    connection = await Connection.connect({ address: temporalAddress });
    temporal = new Client({
      connection,
      namespace: 'default',
      dataConverter: {
        payloadCodecs: [new AesGcmPayloadCodec(secret('temporal_codec_key'))],
      },
    });
  });
  afterAll(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
    await connection?.close();
  });

  type CanaryFixture = Awaited<ReturnType<typeof startAiCanaryRun>>;
  const plant = (mode: 'cloud' | 'byom' | 'sovereign') => {
    const canaries = {
      artifact: marker(),
      prompt: marker(),
      toolArgument: marker(),
      providerError: marker(),
    };
    const named = Object.entries(canaries).map(([id, value]) => ({ id: `${mode}-${id}`, value }));
    protectedMarkers.push(...named);
    return { canaries, named };
  };
  /**
   * Polls the run's own API view until it ends. The stop code and counters travel with the status, and
   * a run that ends any other way says where and why (a 'cancelled' run with no turns was stopped
   * before its first step; 'policy_denied' with ENTITLEMENT_DENIED was refused by the commercial gate).
   */
  type RunView = {
    status: string;
    stop_code: string | null;
    model_turns: number;
    tool_calls: number;
  };
  const ended = async (fixture: CanaryFixture, apiBodies: string[], expected: Partial<RunView>) =>
    expect
      .poll(async (): Promise<RunView> => {
        const result = await api(fixture.owner, 'GET', fixture.runPath);
        expect(result.status).toBe(200);
        apiBodies.push(result.text);
        const view = result.json as RunView;
        return {
          status: view.status,
          stop_code: view.stop_code,
          model_turns: view.model_turns,
          tool_calls: view.tool_calls,
        };
      }, poll)
      .toMatchObject(expected);
  /** Every payload row the run still has, of any kind. FD-5: an ended run keeps none. */
  const payloadsOf = async (fixture: CanaryFixture) =>
    (
      await fixture.su.query(
        `select p.kind, p.content from ai.step_payloads p join ai.execution_steps s on s.id = p.step_id
          where s.run_id = $1`,
        [fixture.runId],
      )
    ).rows;
  /** The real surfaces a canary could leak to: Temporal's store, every service log, audit and views. */
  const scanSurfaces = async (
    fixture: CanaryFixture,
    apiBodies: string[],
    named: { id: string; value: string }[],
  ) => {
    const steps = await api(fixture.owner, 'GET', fixture.stepsPath);
    expect(steps.status).toBe(200);
    expect((steps.json as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
    const { rows: audits } = await fixture.su.query(
      'select row_to_json(a) as row from governance.audit_events a where organization_id = $1',
      [fixture.organizationId],
    );
    expect(audits.length).toBeGreaterThan(0);
    const auditText = JSON.stringify(audits);
    expect(auditText).toContain(fixture.runId);
    const surfaces = [
      { name: 'temporal-persistence', content: dumpTemporal() },
      {
        name: 'service-logs',
        content: compose(
          'logs',
          '--no-color',
          '--no-log-prefix',
          'proxy',
          'web',
          'web-2',
          'worker',
          'agent-worker',
          'dispatcher',
          'temporal',
          'postgres',
        ),
      },
      { name: 'audit', content: auditText },
      { name: 'run-api', content: apiBodies.join('\n') },
      { name: 'steps-api', content: steps.text },
    ];
    for (const replica of ['1', '2'])
      for (const rsc of [false, true]) {
        const response = await fetch(`${BASE}${fixture.timelinePath}`, {
          headers: {
            cookie: fixture.owner.jar.cookie,
            'x-ensemus-test-replica': replica,
            ...(rsc ? { rsc: '1' } : {}),
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(
          rsc ? 'text/x-component' : 'text/html',
        );
        surfaces.push({
          name: `timeline-${rsc ? 'rsc' : 'html'}${replica === '2' ? '-replica-2' : ''}`,
          content: await response.text(),
        });
      }
    expect(surfaces[0]!.content.length).toBeGreaterThan(10000);
    const report = scanCanarySurfaces(surfaces, named);
    expect(report.found).toEqual([]);
    expect(report.passed).toBe(true);
    return steps;
  };

  /**
   * The full real path, as the private fake scripts it: a tool turn, the tool, then a provider 500 that echoes
   * the providerError canary, which fails the run. All four canaries really reached the provider or the draft,
   * and none of them reached any other surface. BYOM and Sovereign both pay their own provider: the pinned
   * profile is customer-billed and nothing the run used is billable.
   */
  const keepsRealPathCanaries = async (
    mode: 'byom' | 'sovereign',
    fixture: CanaryFixture,
    canaries: ReturnType<typeof plant>['canaries'],
    named: ReturnType<typeof plant>['named'],
  ) => {
    const apiBodies = [fixture.start.text];
    await ended(fixture, apiBodies, { status: 'failed' });
    const run = await api(fixture.owner, 'GET', fixture.runPath);
    expect(run.json).toMatchObject({ model_turns: 2, tool_calls: 1 });
    apiBodies.push(run.text);
    const handle = temporal.workflow.getHandle(
      `work-${fixture.organizationId}-${fixture.workUnitId}`,
    );
    await expect.poll(async () => (await handle.describe()).status.name, poll).toBe('COMPLETED');
    const outcome = await handle.result();
    expect(outcome).toMatchObject({ status: 'failed', agentRunId: fixture.runId });

    // Assert the real stored mode and pinned profile, rather than renaming one journey another.
    const { rows: bound } = await fixture.su.query(
      `select o.commercial_mode, r.bound_profile_id, p.provider_kind, p.endpoint_url,
                p.billing_owner, p.secret_ref is null as keyless,
                p.cross_billing_approved_by_membership_id is null as no_cross_billing_consent
           from ai.agent_runs r
           join org.organizations o on o.id = r.organization_id
           join ai.model_profiles p
             on p.organization_id = r.organization_id and p.id = r.bound_profile_id
          where r.organization_id = $1 and r.id = $2`,
      [fixture.organizationId, fixture.runId],
    );
    expect(bound).toEqual([
      {
        commercial_mode: mode,
        bound_profile_id: fixture.profileId,
        provider_kind: 'local_openai_compatible',
        endpoint_url: MODEL_ORIGIN,
        billing_owner: 'customer',
        keyless: true,
        no_cross_billing_consent: true,
      },
    ]);
    const { rows: usage } = await fixture.su.query<{
      meter: string;
      commercial_mode: string;
      billable: boolean;
      profile_id: string | null;
    }>(
      `select meter, commercial_mode, billable, profile_id from platform.usage_ledger
          where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, fixture.runId],
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((entry) => entry.commercial_mode === mode)).toBe(true);
    const modelUsage = usage.filter((entry) => entry.meter.startsWith('model_'));
    expect(modelUsage.length).toBeGreaterThan(0);
    expect(modelUsage.every((entry) => entry.profile_id === fixture.profileId)).toBe(true);
    expect(usage.every((entry) => !entry.billable)).toBe(true);

    // Positive controls show all stages ran. The private fake really received the source and prompt;
    // the next call really received the tool transcript; the draft and its evidence really committed.
    const captured = await fixture.requests();
    expect(captured.historyTruncated).toBe(false);
    expect(captured.requests).toHaveLength(2); // No hidden SDK retry after the scripted provider 500.
    expect(captured.requests[0]?.raw).toContain(canaries.artifact);
    expect(captured.requests[0]?.raw).toContain(canaries.prompt);
    expect(captured.requests[1]?.raw).toContain(canaries.toolArgument);
    const { rows: draftEvidence } = await fixture.su.query(
      'select artifact_id, source_sha256 from ai.artifact_evidence where organization_id = $1',
      [fixture.organizationId],
    );
    expect(draftEvidence).toHaveLength(1);
    expect((await fixture.draftBytes(String(draftEvidence[0]!.artifact_id))).toString('utf8')).toBe(
      canaries.toolArgument,
    );
    // The ended run removes transient prompts, answers and tool arguments (FD-5), through the same
    // native service purge every transcript erasure uses, and records that it did; its allowed draft
    // remains in S3. The tool arguments held the toolArgument canary.
    expect(await payloadsOf(fixture)).toEqual([]);
    const { rows: checkpoint } = await fixture.su.query(
      `select fenced_at is not null as fenced, payloads_purged_at is not null as purged
           from ai.run_input_checkpoints where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, fixture.runId],
    );
    expect(checkpoint).toEqual([{ fenced: true, purged: true }]);

    const steps = await scanSurfaces(fixture, apiBodies, named);
    expect((steps.json as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(4);
  };

  /**
   * ADR-032 D1: a Cloud or BYOM tenant is entitled to model calls only through a hosted subscription, on a
   * deployment with billing named on, and a Sovereign deployment can never have one. So the Cloud and BYOM
   * cases run in the air-gap gate's hosted phase (infrastructure/scripts/air-gap-gate.mjs HOSTED_SUITES), where
   * web, web-2, the worker and the agent-worker run hosted with billing on and this process gets the same
   * settings. The Sovereign case runs in the Sovereign phase. The control runs in both.
   */
  const hostedEntitlement = async (
    mode: 'cloud' | 'byom',
    seeded: { context: TenantContext; app: AppDatabase },
  ) => {
    await seedBillingAccount(seeded.app, seeded.context);
    const plan =
      mode === 'cloud'
        ? await seedPlan({
            mode,
            rateCard: await seedRateCard(),
            features: [FEATURE_AGENT_RUN, FEATURE_MODEL_CALL],
          })
        : await seedPlan({ mode, features: [FEATURE_AGENT_RUN, FEATURE_MODEL_CALL] });
    await startSubscription(seeded.app, seeded.context, { planVersionId: plan.planVersionId });
  };

  it.runIf(HOSTED)(
    'byom: keeps four real-path canaries off persistence, logs, audit and views on a hosted deployment',
    async () => {
      const { canaries, named } = plant('byom');
      const fixture = await startAiCanaryRun(canaries, 'byom', {
        beforeStart: (seeded) => hostedEntitlement('byom', seeded),
      });
      fixtures.push(fixture);
      await keepsRealPathCanaries('byom', fixture, canaries, named);
    },
    120000,
  );

  // Cloud inference stays closed in code until real prepaid holds bind to dispatch and settle exactly once
  // (packages/commercial createEntitlements, 7a2e5ed; docs/06-delivery/evidence/M8-standing-runtime-bindings.md):
  // no configuration can waive it, and this test must not either. Here billing is on and the tenant holds a live
  // Cloud subscription and the explicit grant, so nothing but that closure refuses it. The Ensemus-billed
  // profile is seeded and never bound, and the run's four canaries reach no provider and no other surface.
  // The full Cloud path (billable usage on an Ensemus-billed profile) returns with the prepaid holds.
  it.runIf(HOSTED)(
    'cloud: is refused model calls until prepaid holds exist, with billing on and a live subscription, and keeps its canaries off every surface',
    async () => {
      const { canaries, named } = plant('cloud');
      const fixture = await startAiCanaryRun(canaries, 'cloud', {
        beforeStart: (seeded) => hostedEntitlement('cloud', seeded),
      });
      fixtures.push(fixture);
      const apiBodies = [fixture.start.text];
      // The turn is counted as started (agent-activities' mainStarted) and the gateway refuses it at
      // its first step, the entitlement; the reducer ends the run with that turn's own stop code.
      await ended(fixture, apiBodies, {
        status: 'policy_denied',
        stop_code: 'ENTITLEMENT_DENIED',
        model_turns: 1,
        tool_calls: 0,
      });
      const handle = temporal.workflow.getHandle(
        `work-${fixture.organizationId}-${fixture.workUnitId}`,
      );
      await expect.poll(async () => (await handle.describe()).status.name, poll).toBe('COMPLETED');
      expect(await handle.result()).toMatchObject({
        status: 'policy_denied',
        agentRunId: fixture.runId,
      });
      // The hosted facts are all there: Cloud mode, a live subscription and this month's explicit grant.
      const { rows: facts } = await fixture.su.query(
        `select o.commercial_mode, s.status as subscription_status, r.bound_profile_id
           from ai.agent_runs r
           join org.organizations o on o.id = r.organization_id
           join billing.subscriptions s on s.organization_id = r.organization_id and s.status <> 'canceled'
          where r.organization_id = $1 and r.id = $2`,
        [fixture.organizationId, fixture.runId],
      );
      expect(facts).toEqual([
        { commercial_mode: 'cloud', subscription_status: 'active', bound_profile_id: null },
      ]);
      const { rows: grants } = await fixture.su.query(
        `select mode, period, features from platform.entitlements
          where organization_id = $1 order by version desc limit 1`,
        [fixture.organizationId],
      );
      expect(grants).toEqual([
        {
          mode: 'cloud',
          period: new Date().toISOString().slice(0, 7),
          features: ['agent.run', 'model.call'],
        },
      ]);
      // The profile a Cloud run would use is Ensemus-billed, keyless and private, and was never bound.
      const { rows: profile } = await fixture.su.query(
        `select billing_owner, endpoint_url, secret_ref is null as keyless from ai.model_profiles
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, fixture.profileId],
      );
      expect(profile).toEqual([
        { billing_owner: 'ensemus', endpoint_url: MODEL_ORIGIN, keyless: true },
      ]);
      // Nothing reached the provider, so nothing was charged, drafted or kept.
      const captured = await fixture.requests();
      expect(captured.historyTruncated).toBe(false);
      expect(captured.requests).toEqual([]);
      const { rows: modelUsage } = await fixture.su.query(
        `select meter from platform.usage_ledger
          where organization_id = $1 and run_id = $2 and left(meter, 6) = 'model_'`,
        [fixture.organizationId, fixture.runId],
      );
      expect(modelUsage).toEqual([]);
      const { rows: draftEvidence } = await fixture.su.query(
        'select artifact_id from ai.artifact_evidence where organization_id = $1',
        [fixture.organizationId],
      );
      expect(draftEvidence).toEqual([]);
      expect(await payloadsOf(fixture)).toEqual([]);
      await scanSurfaces(fixture, apiBodies, named);
    },
    120000,
  );

  it.runIf(!HOSTED)(
    'sovereign: keeps four real-path canaries off persistence, logs, audit and views',
    async () => {
      const { canaries, named } = plant('sovereign');
      const fixture = await startAiCanaryRun(canaries, 'sovereign');
      fixtures.push(fixture);
      await keepsRealPathCanaries('sovereign', fixture, canaries, named);
    },
    120000,
  );

  it('control: the same real dump scan detects an unprotected Temporal payload', async () => {
    const control = marker();
    const native = await NativeConnection.connect({
      address: temporalAddress,
      dnsLoadBalancingConfig: null,
    });
    try {
      const { code } = await bundleWorkflowCode({
        workflowsPath: join(here, 'fixtures/canary-workflows.ts'),
        logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} },
      });
      const queue = `m4-canary-control-${randomUUID()}`;
      const worker = await Worker.create({
        connection: native,
        namespace: 'default',
        taskQueue: queue,
        workflowBundle: { code },
        activities: {
          async failWith(value: string) {
            throw new Error(value);
          },
        },
      });
      const unprotected = new Client({ connection, namespace: 'default' });
      await worker.runUntil(async () => {
        const workflow = await unprotected.workflow.start('canaryWorkflow', {
          args: [control],
          taskQueue: queue,
          workflowId: `m4-control-${randomUUID()}`,
        });
        await expect(workflow.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      });
      const dump = dumpTemporal();
      expect(holdsEncodedCanary(dump, control)).toBe(true);
      for (const canary of protectedMarkers)
        expect(holdsEncodedCanary(dump, canary.value)).toBe(false);
    } finally {
      await native.close();
    }
  }, 120000);
});
