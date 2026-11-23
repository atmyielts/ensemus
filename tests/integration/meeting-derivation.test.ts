import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  beginMeetingDerivation,
  denyAllMeetingEgress,
  finishMeetingDerivation,
  listMeetingDerivations,
  listMeetingSummaries,
  listProposedItems,
  noMeetingModel,
  recordMeetingConsent,
  requestMeetingDerivation,
  revokeMeetingProvider,
  type MeetingModelRequest,
} from '@ensemus/application';
import { domainEvents, notifications, openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createMeetingDerivationActivities } from '@ensemus/workflows/meeting-derivation-activities';
import { and, eq } from 'drizzle-orm';
import {
  enableMeetings,
  seedMeeting,
  seedModelApproval,
  seedNotes,
  seedReadyMeeting,
  TEST_NOTICE,
} from '../helpers/expansion';
import { makeTwoTenants } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('native meeting derivation', () => {
  const app = openAppDatabase(urls.app());
  const worker = openAppDatabase(urls.worker());
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  const owner = () => tenants.a.owner.context;
  const service = () => createServiceContext(owner().organizationId);
  const receipt = { modelRef: 'test-model', inputTokens: 70, outputTokens: 30 };
  const preparedRoom = () => seedReadyMeeting(app.db, owner());
  const request = (
    room: { id: string; providerApprovalId: string },
    purpose: 'summarize' | 'extract_items' = 'summarize',
  ) =>
    requestMeetingDerivation(app.db, owner(), {
      meetingId: room.id,
      purpose,
      providerApprovalId: room.providerApprovalId,
    });
  const allow = async () => ({ allowed: true as const, auditRef: randomUUID() });
  const input = (derivationRunId: string) => ({
    organizationId: owner().organizationId,
    derivationRunId,
  });
  const activities = (
    derive: (request: MeetingModelRequest) => Promise<typeof receipt & { output: unknown }>,
    decide = allow,
  ) =>
    createMeetingDerivationActivities({
      database: worker.db,
      model: { derive },
      egress: { decide },
      activity: () => ({ temporalRunId, signal: new AbortController().signal }),
    });
  const temporalRunId = randomUUID();

  beforeAll(async () => {
    tenants = await makeTwoTenants(app.db);
    await enableMeetings(app.db, owner());
  });
  afterAll(async () => {
    await Promise.all([app.close(), worker.close()]);
  });

  it('admits the human organizer, deduplicates a requested notes revision, and publishes identifiers only', async () => {
    const room = await preparedRoom();
    const args = {
      meetingId: room.id,
      purpose: 'summarize' as const,
      providerApprovalId: room.providerApprovalId,
    };
    await expect(
      requestMeetingDerivation(app.db, tenants.a.admin.context, args),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      requestMeetingDerivation(app.db, tenants.b.owner.context, args),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(requestMeetingDerivation(worker.db, service(), args)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const [first, repeat] = await Promise.all([request(room), request(room)]);
    expect(first).toEqual(repeat);
    expect(first.status).toBe('requested');
    expect(await listMeetingDerivations(app.db, owner(), room.id)).toEqual([first]);
    await expect(
      listMeetingDerivations(app.db, tenants.a.admin.context, room.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const events = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({
          actor: domainEvents.actorId,
          type: domainEvents.eventType,
          payload: domainEvents.payload,
        })
        .from(domainEvents)
        .where(eq(domainEvents.aggregateId, first.id)),
    );
    expect(events).toEqual([
      {
        actor: owner().membershipId,
        type: 'meeting.derivation_requested',
        payload: { meeting_id: room.id, purpose: 'summarize' },
      },
    ]);
    await expect(
      beginMeetingDerivation(app.db, service(), {
        derivationRunId: first.id,
        temporalRunId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      beginMeetingDerivation(
        worker.db,
        createServiceContext(tenants.b.owner.context.organizationId),
        {
          derivationRunId: first.id,
          temporalRunId,
        },
      ),
    ).resolves.toEqual({ kind: 'done', status: 'cancelled' });
  });

  it('refuses consent gaps, restricted class, and mismatched provider purpose before queueing', async () => {
    const unconsented = await seedMeeting(app.db, owner());
    const room = await preparedRoom();
    await expect(
      request({ ...unconsented, providerApprovalId: room.providerApprovalId }),
    ).rejects.toMatchObject({
      code: 'CONSENT_INCOMPLETE',
    });
    const providerApprovalId = await seedModelApproval(app.db, owner(), {
      purposes: ['extract_items'],
    });
    await expect(request({ ...room, providerApprovalId })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_APPROVED',
    });
    const restricted = await seedMeeting(app.db, owner(), { classification: 'restricted' });
    await recordMeetingConsent(app.db, owner(), {
      meetingId: restricted.id,
      participantId: restricted.organizerParticipantId,
      decision: 'granted',
      noticeRef: TEST_NOTICE,
    });
    await seedNotes(app.db, owner(), { meetingId: restricted.id, classification: 'restricted' });
    await expect(
      request({ ...restricted, providerApprovalId: room.providerApprovalId }),
    ).rejects.toMatchObject({
      code: 'CLASSIFICATION_NOT_ALLOWED',
    });
  });

  it('stores a generated summary once and keeps the provider answer out of the event stream', async () => {
    const room = await preparedRoom();
    const run = await request(room);
    const summary = 'Generated summary visible only in the meeting';
    const derive = vi.fn(async () => ({ ...receipt, output: { summary } }));
    const activity = activities(derive);
    expect(await activity.runMeetingDerivation(input(run.id))).toBe('completed');
    expect(await activity.runMeetingDerivation(input(run.id))).toBe('completed');
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: 'Nothing here is real.',
        participantCount: 1,
        classification: 'confidential',
      }),
    );
    expect(await listMeetingSummaries(app.db, owner(), room.id)).toEqual([
      expect.objectContaining({ runId: run.id, text: summary, trust: 'model_generated' }),
    ]);
    const completed = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({ payload: domainEvents.payload })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.aggregateId, run.id),
            eq(domainEvents.eventType, 'meeting.derivation_completed'),
          ),
        ),
    );
    expect(completed).toEqual([{ payload: { meeting_id: room.id, purpose: 'summarize' } }]);
  });

  it('writes proposals without creating work and validates the suggested owner and date', async () => {
    const room = await preparedRoom();
    const run = await request(room, 'extract_items');
    const derive = async () => ({
      ...receipt,
      output: {
        items: [
          {
            title: 'Draft follow-up',
            kind: 'work',
            suggested_participant: 1,
            suggested_due_on: '2030-02-28',
          },
          {
            title: 'Draft decision',
            kind: 'decision',
            suggested_participant: 3,
            suggested_due_on: '2030-02-30',
          },
        ],
      },
    });
    expect(await activities(derive).runMeetingDerivation(input(run.id))).toBe('completed');
    expect(await listProposedItems(app.db, owner(), room.id)).toEqual([
      expect.objectContaining({
        title: 'Draft follow-up',
        status: 'proposed',
        workUnitId: null,
        suggestedOwnerMembershipId: owner().membershipId,
        suggestedDueOn: '2030-02-28',
      }),
      expect.objectContaining({
        title: 'Draft decision',
        status: 'proposed',
        workUnitId: null,
        suggestedOwnerMembershipId: null,
        suggestedDueOn: null,
      }),
    ]);
  });

  it('refuses an unapproved egress decision, approval revoked in preflight, and replaced notes', async () => {
    const derive = vi.fn(async () => ({
      ...receipt,
      output: { summary: 'must never be generated' },
    }));
    const room = await preparedRoom();
    const denied = await request(room);
    const deny = createMeetingDerivationActivities({
      database: worker.db,
      model: { derive },
      egress: denyAllMeetingEgress,
      activity: () => ({ temporalRunId, signal: new AbortController().signal }),
    });
    expect(await deny.runMeetingDerivation(input(denied.id))).toBe('refused');

    const lateRevocation = await request(room);
    const revoke = async () => {
      await revokeMeetingProvider(app.db, owner(), { providerApprovalId: room.providerApprovalId });
      return allow();
    };
    expect(await activities(derive, revoke).runMeetingDerivation(input(lateRevocation.id))).toBe(
      'refused',
    );
    expect(await listMeetingDerivations(app.db, owner(), room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: denied.id, statusCode: 'EGRESS_DENIED' }),
        expect.objectContaining({ id: lateRevocation.id, statusCode: 'PROVIDER_NOT_APPROVED' }),
      ]),
    );

    const other = await preparedRoom();
    const stale = await request(other);
    await seedNotes(app.db, owner(), { meetingId: other.id, version: 2 });
    expect(await activities(derive).runMeetingDerivation(input(stale.id))).toBe('refused');
    expect(await listMeetingDerivations(app.db, owner(), other.id)).toEqual([
      expect.objectContaining({ statusCode: 'NOTES_NOT_CURRENT' }),
    ]);
    expect(derive).not.toHaveBeenCalled();
  });

  it('drops a late answer after someone withdraws and emits no proposal notification', async () => {
    const room = await preparedRoom();
    const run = await request(room, 'extract_items');
    const derive = async () => {
      await recordMeetingConsent(app.db, owner(), {
        meetingId: room.id,
        participantId: room.organizerParticipantId,
        decision: 'withdrawn',
        noticeRef: TEST_NOTICE,
      });
      return { ...receipt, output: { items: [{ title: 'must be erased', kind: 'work' }] } };
    };
    expect(await activities(derive).runMeetingDerivation(input(run.id))).toBe('dropped');
    expect(await listProposedItems(app.db, owner(), room.id)).toEqual([]);
    const published = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({ kind: notifications.kind })
        .from(notifications)
        .where(eq(notifications.targetRef, 'meeting:' + room.id)),
    );
    expect(published.map((event) => event.kind)).not.toContain('meeting.items_proposed');
  });

  it('keeps a failed persistence bind out of the Activity failure and retries safely', async () => {
    const room = await preparedRoom();
    const run = await request(room);
    const privateText = 'Generated private summary included in a simulated SQL error';
    let first = true;
    const transaction = vi.spyOn(worker.db, 'transaction');
    const derive = vi.fn(async () => {
      if (first) {
        first = false;
        transaction.mockRejectedValueOnce(new Error(privateText));
      }
      return { ...receipt, output: { summary: privateText } };
    });
    try {
      const activity = activities(derive);
      await expect(activity.runMeetingDerivation(input(run.id))).rejects.toThrow(
        /^MEETING_DERIVATION_ACTIVITY_FAILED$/,
      );
      expect(await listMeetingSummaries(app.db, owner(), room.id)).toEqual([]);
      expect(await activity.runMeetingDerivation(input(run.id))).toBe('completed');
      expect(await listMeetingSummaries(app.db, owner(), room.id)).toHaveLength(1);
      expect(derive).toHaveBeenCalledTimes(2);
    } finally {
      transaction.mockRestore();
    }
  });

  it('refuses untrusted output and safely settles an interrupted activity once', async () => {
    const room = await preparedRoom();
    const malformed = await request(room, 'extract_items');
    const bad = async () => ({
      ...receipt,
      output: {
        items: [
          { title: 'Proposed task', kind: 'work', status: 'accepted', work_unit_id: randomUUID() },
        ],
      },
    });
    const activity = activities(bad);
    expect(await activity.runMeetingDerivation(input(malformed.id))).toBe('refused');
    expect(await listProposedItems(app.db, owner(), room.id)).toEqual([]);

    const stopped = await request(room);
    const ownerRun = { derivationRunId: stopped.id, temporalRunId };
    expect(await beginMeetingDerivation(worker.db, service(), ownerRun)).toMatchObject({
      kind: 'go',
    });
    const staleIdentity = { ...ownerRun, temporalRunId: randomUUID() };
    expect(
      await finishMeetingDerivation(worker.db, service(), {
        ...staleIdentity,
        answer: { ...receipt, output: { summary: 'another execution' } },
      }),
    ).toEqual({ status: 'dropped', items: 0 });
    expect(await activity.stopInterruptedDerivation(input(stopped.id))).toBe('failed');
    expect(await activity.stopInterruptedDerivation(input(stopped.id))).toBe('failed');

    const unavailable = await request(room);
    expect(
      await activities(noMeetingModel.derive).runMeetingDerivation(input(unavailable.id)),
    ).toBe('failed');
    expect(await listMeetingSummaries(app.db, owner(), room.id)).toEqual([]);
    expect(await listMeetingDerivations(app.db, owner(), room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: malformed.id, statusCode: 'MODEL_OUTPUT_INVALID' }),
        expect.objectContaining({ id: stopped.id, statusCode: 'MODEL_UNAVAILABLE' }),
        expect.objectContaining({ id: unavailable.id, statusCode: 'MODEL_UNAVAILABLE' }),
      ]),
    );
  });
});
