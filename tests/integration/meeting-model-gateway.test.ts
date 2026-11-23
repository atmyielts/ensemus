import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  beginMeetingDerivation,
  claimMeetingModelDispatch,
  listMeetingDerivations,
  listMeetingSummaries,
  listProposedItems,
  requestMeetingDerivation,
  revokeMeetingProvider,
} from '@ensemus/application';
import { createEntitlements, FEATURE_MODEL_CALL } from '@ensemus/commercial';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import {
  egressDecisions,
  meetingDerivationRuns,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { modelProfileRef } from '@ensemus/domain/meeting';
import { createEndpointGuard, createModelAdapter } from '@ensemus/intelligence';
import { createMeetingDerivationActivities } from '@ensemus/workflows/meeting-derivation-activities';
import { eq } from 'drizzle-orm';
import { createGovernedMeetingModel } from '../../workers/workflow/src/meeting-model';
import { seedActiveProfile } from '../helpers/ai/fixtures';
import {
  enableMeetings,
  seedModelApproval,
  seedNotes,
  seedReadyMeeting,
} from '../helpers/expansion';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
import { seedPlan } from '../helpers/saas';

describe('governed meeting model transport', () => {
  const app = openAppDatabase(urls.app());
  const agent = openAppDatabase(urls.agent());
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  const owner = () => tenants.a.owner.context;
  const system = () => createServiceContext(owner().organizationId);
  const sent: Array<{ path: string; body: string }> = [];
  let serverUrl: string;
  let reply: unknown;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      sent.push({ body, path: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'generated-meeting-completion',
          object: 'chat.completion',
          created: 1,
          model: 'scripted-test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(reply) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 },
        }),
      );
    });
  });
  const temporalRunId = randomUUID();
  const noKey = vi.fn(async () => {
    throw new Error('Fixture never lends credentials');
  });

  beforeAll(async () => {
    tenants = await makeTwoTenants(app.db);
    await proveSecondFactor(tenants.a.owner);
    const plan = await seedPlan({ mode: 'byom', features: [FEATURE_MODEL_CALL] });
    await startSubscription(app.db, owner(), { planVersionId: plan.planVersionId });
    await enableMeetings(app.db, owner());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fake model did not open a loopback port');
    serverUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
      app.close(),
      agent.close(),
    ]);
  });

  const model = (overrides: Partial<Parameters<typeof createGovernedMeetingModel>[0]> = {}) =>
    createGovernedMeetingModel({
      database: agent.db,
      entitlements: createEntitlements(agent.db, { billingEnabled: true }),
      residency: { check: async () => ({ allowed: true, requiredRegion: null }) },
      adapter: createModelAdapter(),
      guard: createEndpointGuard(),
      credentials: { withKey: noKey },
      privateEndpoints: [serverUrl],
      canaries: ['SYNTHETIC-MEETING-SECRET-BOUNDARY'],
      ...overrides,
    });
  async function setup(
    purpose: 'summarize' | 'extract_items' = 'summarize',
    options: {
      notes?: string;
      profilePurposes?: string[];
    } = {},
  ) {
    const room = await seedReadyMeeting(app.db, owner());
    const profileId = await seedActiveProfile(app.db, agent.db, owner(), {
      endpointUrl: serverUrl + '/v1',
      allowedClasses: ['internal', 'confidential'],
      allowedPurposes: options.profilePurposes ?? ['compose', 'extract'],
      limits: { maxInputTokens: 16384, maxOutputTokens: 512 },
    });
    if (options.notes !== undefined) {
      await seedNotes(app.db, owner(), { meetingId: room.id, version: 2, text: options.notes });
    }
    const approval = await seedModelApproval(app.db, owner(), {
      targetRef: modelProfileRef(profileId),
    });
    const run = await requestMeetingDerivation(app.db, owner(), {
      meetingId: room.id,
      purpose,
      providerApprovalId: approval,
    });
    return { room, profileId, approval, run };
  }
  const start = (
    runId: string,
    overrides?: Partial<Parameters<typeof createGovernedMeetingModel>[0]>,
  ) =>
    createMeetingDerivationActivities({
      database: agent.db,
      governedModel: model(overrides),
      activity: () => ({ temporalRunId, signal: new AbortController().signal }),
    }).runMeetingDerivation({ organizationId: owner().organizationId, derivationRunId: runId });

  const decisions = (profileId: string) =>
    withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({
          kind: egressDecisions.decision,
          purpose: egressDecisions.purpose,
          code: egressDecisions.reasonCode,
          dataClass: egressDecisions.dataClass,
          hash: egressDecisions.requestHash,
        })
        .from(egressDecisions)
        .where(eq(egressDecisions.profileId, profileId)),
    );

  it('sends only the approved notes to the pinned local profile after an audit receipt commits', async () => {
    const { room, run, profileId } = await setup();
    const before = sent.length;
    reply = { summary: 'Generated model summary' };
    const adapter = createModelAdapter();
    await expect(
      start(run.id, {
        adapter: {
          async generate(call, signal) {
            expect(await decisions(profileId)).toEqual([
              {
                kind: 'allow',
                purpose: 'compose',
                code: 'ALLOWED',
                dataClass: 'confidential',
                hash: expect.stringMatching(/^[0-9a-f]{64}$/),
              },
            ]);
            return adapter.generate(call, signal);
          },
        },
      }),
    ).resolves.toBe('completed');
    expect(sent).toHaveLength(before + 1);
    const request = sent.at(-1)!;
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body).toContain('Nothing here is real.');
    expect(request.body).not.toContain(owner().membershipId);
    expect(request.body).not.toContain(owner().organizationId);
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'scripted-test-model',
      messages: [
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ],
    });
    expect(await listMeetingSummaries(app.db, owner(), room.id)).toEqual([
      expect.objectContaining({ text: 'Generated model summary', trust: 'model_generated' }),
    ]);
    await expect(start(run.id)).resolves.toBe('completed');
    expect(sent).toHaveLength(before + 1);
    expect(noKey).not.toHaveBeenCalled();
  });

  it('accepts strict proposal JSON with null suggestions and never creates work', async () => {
    const { room, run, profileId } = await setup('extract_items');
    reply = {
      items: [
        {
          kind: 'work',
          title: 'Generated follow-up',
          detail: null,
          suggested_participant: null,
          suggested_due_on: null,
        },
      ],
    };
    await expect(start(run.id)).resolves.toBe('completed');
    expect(await listProposedItems(app.db, owner(), room.id)).toEqual([
      expect.objectContaining({
        title: 'Generated follow-up',
        workUnitId: null,
        status: 'proposed',
        suggestedOwnerMembershipId: null,
      }),
    ]);
    expect(await decisions(profileId)).toEqual([
      expect.objectContaining({ kind: 'allow', purpose: 'extract' }),
    ]);
  });

  it('blocks secrets, purpose mismatch, and revocation during policy preflight', async () => {
    const before = sent.length;
    const sensitive = await setup('summarize', { notes: 'SYNTHETIC-MEETING-SECRET-BOUNDARY' });
    await expect(start(sensitive.run.id)).resolves.toBe('refused');
    expect(await decisions(sensitive.profileId)).toEqual([
      expect.objectContaining({ kind: 'deny', code: 'CLASS_DENIED', dataClass: 'restricted' }),
    ]);

    const wrongPurpose = await setup('extract_items', { profilePurposes: ['compose'] });
    await expect(start(wrongPurpose.run.id)).resolves.toBe('refused');
    expect(await decisions(wrongPurpose.profileId)).toEqual([
      expect.objectContaining({ kind: 'deny', code: 'PURPOSE_NOT_ON_PROFILE' }),
    ]);

    const revoked = await setup();
    await expect(
      start(revoked.run.id, {
        residency: {
          async check() {
            await revokeMeetingProvider(app.db, owner(), { providerApprovalId: revoked.approval });
            return { allowed: true, requiredRegion: null };
          },
        },
      }),
    ).resolves.toBe('refused');
    expect(await listMeetingDerivations(app.db, owner(), revoked.room.id)).toEqual([
      expect.objectContaining({ statusCode: 'PROVIDER_NOT_APPROVED' }),
    ]);
    expect(sent).toHaveLength(before);
    expect(noKey).not.toHaveBeenCalled();
  });

  it('does not resend after a committed dispatch when the worker has lost the result', async () => {
    const { room, run, profileId } = await setup();
    const before = sent.length;
    const identity = { derivationRunId: run.id, temporalRunId };
    const admission = await beginMeetingDerivation(agent.db, system(), identity);
    expect(admission.kind).toBe('go');
    if (admission.kind !== 'go') throw new Error('Fixture did not reach model admission');
    const claim = {
      ...admission.prepared,
      temporalRunId,
      profileVersion: 1,
      effectiveClass: 'confidential' as const,
      transportRefusal: null,
    };
    await expect(
      claimMeetingModelDispatch(
        agent.db,
        createServiceContext(tenants.b.owner.context.organizationId),
        claim,
      ),
    ).resolves.toEqual({ allowed: false, code: 'EGRESS_DENIED' });
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx
          .update(meetingDerivationRuns)
          .set({ dispatchStartedAt: new Date() })
          .where(eq(meetingDerivationRuns.id, run.id)),
      ),
    ).rejects.toThrow();
    const response = model();
    reply = { summary: 'Generated result not delivered to persistence' };
    await expect(
      response.derive({
        ...admission.prepared,
        organizationId: owner().organizationId,
        temporalRunId,
        participantCount: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ modelRef: profileId });
    expect(sent).toHaveLength(before + 1);
    await expect(start(run.id)).resolves.toBe('failed');
    expect(sent).toHaveLength(before + 1);
    expect(await decisions(profileId)).toHaveLength(1);
    expect(await listMeetingSummaries(app.db, owner(), room.id)).toEqual([]);
  });
});
