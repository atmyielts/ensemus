// SEC-02 / SEC-04, ADR-024 acceptance row 3 and ADR-028 assurance. This is a real built-stack gate,
// not an in-memory scan: HTTP start -> outbox -> Temporal -> agent-worker -> private fake -> tool.
// No Docker is started here. Opt in with ENSEMUS_AI_ENABLED=true on an already running test stack.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdsEncodedCanary, scanCanarySurfaces } from '../../evaluations/safety/canary-scan';
import { BASE } from '../helpers/forms';
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

  it.each(['cloud', 'byom', 'sovereign'] as const)(
    '%s: keeps four real-path canaries off persistence, logs, audit and views',
    async (mode) => {
      const canaries = {
        artifact: marker(),
        prompt: marker(),
        toolArgument: marker(),
        providerError: marker(),
      };
      const named = Object.entries(canaries).map(([id, value]) => ({ id: `${mode}-${id}`, value }));
      protectedMarkers.push(...named);
      const fixture = await startAiCanaryRun(canaries, mode);
      fixtures.push(fixture);
      const apiBodies = [fixture.start.text];
      await expect
        .poll(async () => {
          const result = await api(fixture.owner, 'GET', fixture.runPath);
          expect(result.status).toBe(200);
          apiBodies.push(result.text);
          return (result.json as { status: string }).status;
        }, poll)
        .toBe('failed');
      const run = await api(fixture.owner, 'GET', fixture.runPath);
      expect(run.json).toMatchObject({ model_turns: 2, tool_calls: 1 });
      apiBodies.push(run.text);
      const handle = temporal.workflow.getHandle(
        `work-${fixture.organizationId}-${fixture.workUnitId}`,
      );
      await expect.poll(async () => (await handle.describe()).status.name, poll).toBe('COMPLETED');
      const outcome = await handle.result();
      expect(outcome).toMatchObject({ status: 'failed', agentRunId: fixture.runId });

      // Assert the real stored mode and pinned profile, rather than renaming a BYOM journey Cloud.
      // The private fake exercises Cloud entitlement/billing semantics, not a hosted provider.
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
          billing_owner: mode === 'cloud' ? 'ensemus' : 'customer',
          keyless: true,
          no_cross_billing_consent: true,
        },
      ]);
      if (mode === 'cloud') {
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
      }
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
      expect(modelUsage.every((entry) => entry.billable === (mode === 'cloud'))).toBe(true);
      if (mode !== 'cloud') expect(usage.every((entry) => !entry.billable)).toBe(true);

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
      expect(
        (await fixture.draftBytes(String(draftEvidence[0]!.artifact_id))).toString('utf8'),
      ).toBe(canaries.toolArgument);
      const { rows: toolArgs } = await fixture.su.query(
        `select p.content from ai.step_payloads p join ai.execution_steps s on s.id = p.step_id
       where s.run_id = $1 and p.kind = 'tool_args'`,
        [fixture.runId],
      );
      // The completed run removes transient prompts/tool arguments; its allowed draft remains in S3.
      expect(toolArgs).toEqual([]);

      const steps = await api(fixture.owner, 'GET', fixture.stepsPath);
      expect(steps.status).toBe(200);
      expect((steps.json as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(4);
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
