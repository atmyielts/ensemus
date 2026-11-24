import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acceptProposedDecision,
  acceptProposedWork,
  createWorkUnit,
  getWorkUnit,
  listMeetingSummaries,
  listProposedItems,
  recordMeetingConsent,
  rejectProposedItem,
} from '@ensemus/application';
import {
  domainEvents,
  meetingProposedItems,
  openAppDatabase,
  withTenantTx,
  workUnits,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq } from 'drizzle-orm';
import { seedMeetingSuggestions, TEST_NOTICE } from '../helpers/expansion';
import { makeTwoTenants } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('meeting suggestions and decisions', () => {
  const app = openAppDatabase(urls.app());
  const worker = openAppDatabase(urls.worker());
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  const owner = () => tenants.a.owner.context;
  beforeAll(async () => {
    tenants = await makeTwoTenants(app.db);
  });
  afterAll(async () => {
    await app.close();
    await worker.close();
  });
  const make = () => seedMeetingSuggestions(app.db, owner(), tenants.a.member.context);
  const workInput = (itemId: string) => ({
    itemId,
    expectedVersion: 1,
    title: 'Human decision ' + randomUUID(),
    objective: 'The person wrote these details.',
    ownerMembershipId: owner().membershipId,
    dueAt: new Date('2036-05-09T12:00:00Z'),
  });
  const findWork = (title: string) =>
    withTenantTx(app.db, owner(), (tx) =>
      tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.title, title)),
    );

  it('shows derived material to attendees and only metadata to administrators outside the room', async () => {
    const room = await make();
    expect(await listMeetingSummaries(app.db, tenants.a.member.context, room.id)).toEqual([
      expect.objectContaining({ text: room.summaryText, trust: 'model_generated' }),
    ]);
    const items = await listProposedItems(app.db, owner(), room.id);
    expect(items.map((item) => item.status)).toEqual(['proposed', 'proposed', 'proposed']);
    expect(items.every((item) => item.workUnitId === null)).toBe(true);
    for (const viewer of [tenants.a.admin.context, tenants.b.owner.context]) {
      await expect(listProposedItems(app.db, viewer, room.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(listMeetingSummaries(app.db, viewer, room.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(acceptProposedWork(app.db, viewer, workInput(room.work))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    const service = createServiceContext(owner().organizationId);
    await expect(listProposedItems(worker.db, service, room.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(listMeetingSummaries(worker.db, service, room.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      acceptProposedWork(worker.db, service, workInput(room.work)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      acceptProposedDecision(worker.db, service, { itemId: room.decision, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      rejectProposedItem(worker.db, service, { itemId: room.dismiss, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records and dismisses suggestions without creating work', async () => {
    const room = await make();
    const member = tenants.a.member.context;
    const decision = { itemId: room.decision, expectedVersion: 1 };
    await expect(
      acceptProposedWork(app.db, member, workInput(room.decision)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      acceptProposedDecision(app.db, member, { ...decision, expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      acceptProposedDecision(app.db, member, { ...decision, reason: 'Confirmed by the team.' }),
    ).resolves.toEqual({ version: 2 });
    await expect(
      rejectProposedItem(app.db, owner(), { itemId: room.dismiss, expectedVersion: 1 }),
    ).resolves.toEqual({ version: 2 });
    const items = await listProposedItems(app.db, owner(), room.id);
    expect(items).toContainEqual(
      expect.objectContaining({
        id: room.decision,
        status: 'accepted',
        decidedByMembershipId: member.membershipId,
      }),
    );
    expect(items).toContainEqual(expect.objectContaining({ id: room.dismiss, status: 'rejected' }));
    expect(items.every((item) => item.workUnitId === null)).toBe(true);
  });

  it('commits one human-authored work unit when two acceptances race', async () => {
    const room = await make();
    const input = workInput(room.work);
    await expect(
      acceptProposedWork(app.db, owner(), {
        ...input,
        ownerMembershipId: tenants.b.owner.context.membershipId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await findWork(input.title)).toEqual([]);
    const race = await Promise.allSettled([
      acceptProposedWork(app.db, owner(), input),
      acceptProposedWork(app.db, owner(), input),
    ]);
    const winner = race.find((entry) => entry.status === 'fulfilled');
    const denied = race.find((entry) => entry.status === 'rejected');
    expect(denied?.reason).toMatchObject({ code: 'PROPOSAL_ALREADY_DECIDED' });
    if (!winner) throw new Error('Expected one committed work unit');
    const work = await getWorkUnit(app.db, owner(), winner.value.workUnitId);
    expect(work).toMatchObject({
      title: input.title,
      objective: input.objective,
      classification: 'confidential',
      ownerMembershipId: input.ownerMembershipId,
      dueAt: input.dueAt,
      status: 'queued',
    });
    expect(await findWork(input.title)).toEqual([{ id: work.id }]);
    const events = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({ payload: domainEvents.payload })
        .from(domainEvents)
        .where(eq(domainEvents.aggregateId, room.work)),
    );
    expect(events).toEqual([{ payload: { item_id: room.work, meeting_id: room.id } }]);
  });

  it('rejects direct decisions under another attendee’s name and work at a lower classification', async () => {
    const room = await make();
    const dbRefusal = { cause: { code: 'EN113' } };
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx
          .update(meetingProposedItems)
          .set({
            status: 'accepted',
            version: 2,
            decidedAt: new Date(),
            decidedByMembershipId: tenants.a.member.context.membershipId,
          })
          .where(eq(meetingProposedItems.id, room.decision)),
      ),
    ).rejects.toMatchObject(dbRefusal);
    const unrelatedWork = await createWorkUnit(app.db, owner(), {
      title: 'Generated internal work',
      classification: 'internal',
    });
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx
          .update(meetingProposedItems)
          .set({
            status: 'accepted',
            version: 2,
            decidedAt: new Date(),
            decidedByMembershipId: owner().membershipId,
            workUnitId: unrelatedWork.id,
          })
          .where(eq(meetingProposedItems.id, room.work)),
      ),
    ).rejects.toMatchObject(dbRefusal);
  });

  it('rolls back work and decision together when the transaction fails', async () => {
    const room = await make();
    const input = workInput(room.work);
    const fault = new Error('generated failure before commit');
    const transaction = app.db.transaction.bind(app.db);
    const mocked = vi.spyOn(app.db, 'transaction').mockImplementationOnce((bindings, use) =>
      transaction(bindings, async (tx) => {
        await use(tx);
        throw fault;
      }),
    );
    try {
      await expect(acceptProposedWork(app.db, owner(), input)).rejects.toBe(fault);
    } finally {
      mocked.mockRestore();
    }
    expect(await findWork(input.title)).toEqual([]);
    expect(
      (await listProposedItems(app.db, owner(), room.id)).find((row) => row.id === room.work),
    ).toMatchObject({ status: 'proposed', version: 1, workUnitId: null });
  });

  it('purges derived text and forbids subsequent decisions while preserving work already made', async () => {
    const room = await make();
    const input = workInput(room.work);
    const accepted = await acceptProposedWork(app.db, owner(), input);
    await recordMeetingConsent(app.db, owner(), {
      meetingId: room.id,
      participantId: room.organizerParticipantId,
      noticeRef: TEST_NOTICE,
      decision: 'withdrawn',
    });
    expect(await listMeetingSummaries(app.db, owner(), room.id)).toEqual([
      expect.objectContaining({ text: null }),
    ]);
    const items = await listProposedItems(app.db, owner(), room.id);
    expect(items.every((item) => item.title === null && item.detail === null)).toBe(true);
    expect(items).toContainEqual(
      expect.objectContaining({ id: room.decision, status: 'withdrawn' }),
    );
    await expect(
      acceptProposedDecision(app.db, owner(), { itemId: room.decision, expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: 'MEETING_PURGED' });
    expect((await getWorkUnit(app.db, owner(), accepted.workUnitId)).title).toBe(input.title);
  });
});
