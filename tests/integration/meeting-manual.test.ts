import { updateSecurityPolicy } from '@ensemus/application/security-policy';
// Manual meeting notes through the real services, native sessions, forced RLS and consent triggers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  domainEvents,
  meetingConsentRecords,
  meetingNotes,
  memberships,
  openAppDatabase,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { ledgerKeyFor, serializeLedgerEntry } from '@ensemus/domain/tombstone-ledger';
import {
  addMeetingParticipant,
  createMeeting,
  getMeeting,
  getMeetingSettings,
  importMeetingNotes,
  listMeetings,
  purgeMeetingContentInTx,
  recordMeetingConsent,
  removeMeetingParticipant,
  countUnappliedTombstones,
  reapplyTombstoneLedger,
  updateMeetingSettings,
} from '@ensemus/application';
import {
  makePerson,
  makeTwoTenants,
  nativePersonContext,
  proveSecondFactor,
} from '../helpers/product';
import { urls } from '../helpers/stack';

const notice = 'generated-notice-v1';
const refused = (code: string) => expect.objectContaining({ code });
describe('manual meeting registration, consent and notes', () => {
  const app = openAppDatabase(urls.app());
  const worker = openAppDatabase(urls.worker());
  let pair: Awaited<ReturnType<typeof makeTwoTenants>>;
  let owner: TenantContext, admin: TenantContext, member: TenantContext, outsider: TenantContext;
  beforeAll(async () => {
    pair = await makeTwoTenants(app.db);
    owner = pair.a.owner.context;
    admin = pair.a.admin.context;
    member = pair.a.member.context;
    const person = await makePerson('meeting-outsider');
    await withTenantTx(app.db, owner, (tx) =>
      tx.insert(memberships).values({
        organizationId: owner.organizationId,
        userId: person.userId,
        role: 'member',
        status: 'active',
      }),
    );
    outsider = await nativePersonContext(app.db, person, owner.organizationId);
  });
  afterAll(async () => {
    await worker.close();
    await app.close();
  });
  async function enable() {
    const settings = await getMeetingSettings(app.db, owner);
    if (!settings.enabled || settings.noticeRef !== notice)
      await updateMeetingSettings(app.db, owner, {
        enabled: true,
        noticeRef: notice,
        expectedVersion: settings.version,
      });
  }
  async function meeting() {
    await enable();
    return createMeeting(app.db, owner, {
      title: `Private generated meeting ${randomUUID()}`,
      occurredAt: new Date(),
    });
  }
  async function granted() {
    const m = await meeting();
    await recordMeetingConsent(app.db, owner, {
      meetingId: m.id,
      participantId: m.participants[0]!.id,
      decision: 'granted',
      noticeRef: notice,
    });
    return getMeeting(app.db, owner, m.id);
  }
  it('starts off without a stored settings row and refuses creation', async () => {
    expect(await getMeetingSettings(app.db, owner)).toEqual({
      enabled: false,
      noticeRef: null,
      version: 1,
    });
    await expect(
      createMeeting(app.db, owner, { title: 'Generated', occurredAt: new Date() }),
    ).rejects.toEqual(refused('MEETINGS_NOT_ENABLED'));
  });
  it('requires an administrator, a notice and the current settings version', async () => {
    await expect(
      updateMeetingSettings(app.db, member, {
        enabled: true,
        noticeRef: notice,
        expectedVersion: 0,
      }),
    ).rejects.toEqual(refused('FORBIDDEN'));
    await expect(
      updateMeetingSettings(app.db, owner, { enabled: true, noticeRef: null, expectedVersion: 0 }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    await enable();
    await expect(
      updateMeetingSettings(app.db, admin, {
        enabled: false,
        noticeRef: notice,
        expectedVersion: 0,
      }),
    ).rejects.toEqual(refused('VERSION_CONFLICT'));
    expect((await getMeetingSettings(app.db, owner)).enabled).toBe(true);
  });
  it('automatically lists the organizer, with confidential content and pending consent', async () => {
    const m = await meeting();
    expect(m).toMatchObject({
      classification: 'confidential',
      status: 'open',
      sourceKind: 'manual',
      consent: 'pending',
      version: 1,
      currentNotes: null,
    });
    expect(m.participants).toHaveLength(1);
    expect(m.participants[0]).toMatchObject({
      kind: 'member',
      membershipId: owner.membershipId,
      decision: null,
    });
  });
  it('reveals no title, notes or participants to an administrator outside the room', async () => {
    const m = await granted();
    await importMeetingNotes(app.db, owner, {
      meetingId: m.id,
      text: 'GENERATED_PRIVATE_NOTE_CANARY',
    });
    const view = await getMeeting(app.db, admin, m.id);
    expect(view).toMatchObject({
      title: null,
      participants: [],
      currentNotes: null,
      consent: 'complete',
    });
    expect(JSON.stringify(view)).not.toContain('GENERATED_PRIVATE_NOTE_CANARY');
    expect(JSON.stringify(view)).not.toContain(m.title!);
    const list = await listMeetings(app.db, admin, {});
    expect(list.items.find((row) => row.id === m.id)?.title).toBeNull();
  });
  it('answers not found for a same-company nonparticipant and another tenant', async () => {
    const m = await meeting();
    for (const who of [outsider, pair.b.owner.context]) {
      await expect(getMeeting(app.db, who, m.id)).rejects.toEqual(refused('NOT_FOUND'));
      expect((await listMeetings(app.db, who, {})).items.some((row) => row.id === m.id)).toBe(
        false,
      );
    }
  });
  it('lets each member answer only for themselves and checks the current notice', async () => {
    const m = await meeting();
    const p = await addMeetingParticipant(app.db, owner, {
      meetingId: m.id,
      expectedVersion: m.version,
      participant: { kind: 'member', membershipId: member.membershipId },
    });
    await expect(
      recordMeetingConsent(app.db, owner, {
        meetingId: m.id,
        participantId: p.id,
        decision: 'granted',
        noticeRef: notice,
      }),
    ).rejects.toEqual(refused('CONSENT_NOT_YOURS'));
    await expect(
      recordMeetingConsent(app.db, member, {
        meetingId: m.id,
        participantId: p.id,
        decision: 'granted',
        noticeRef: 'stale-notice',
      }),
    ).rejects.toEqual(refused('CONSENT_NOTICE_NOT_CURRENT'));
    expect(
      await recordMeetingConsent(app.db, member, {
        meetingId: m.id,
        participantId: p.id,
        decision: 'granted',
        noticeRef: notice,
      }),
    ).toMatchObject({ consent: 'pending' });
  });
  it("records an outside answer as the organizer's attestation, never another member's", async () => {
    const m = await meeting();
    const p = await addMeetingParticipant(app.db, owner, {
      meetingId: m.id,
      expectedVersion: m.version,
      participant: { kind: 'external', label: 'Generated outside participant' },
    });
    await expect(
      recordMeetingConsent(app.db, member, {
        meetingId: m.id,
        participantId: p.id,
        decision: 'granted',
        noticeRef: notice,
      }),
    ).rejects.toEqual(refused('NOT_FOUND'));
    await recordMeetingConsent(app.db, owner, {
      meetingId: m.id,
      participantId: p.id,
      decision: 'granted',
      noticeRef: notice,
    });
    expect(
      (await getMeeting(app.db, owner, m.id)).participants.find((row) => row.id === p.id),
    ).toMatchObject({ basis: 'attested', decision: 'granted' });
  });
  it('refuses notes until everyone agrees, appends versions and freezes the participant list', async () => {
    const m = await meeting();
    await expect(
      importMeetingNotes(app.db, owner, { meetingId: m.id, text: 'not admitted' }),
    ).rejects.toEqual(refused('CONSENT_INCOMPLETE'));
    await recordMeetingConsent(app.db, owner, {
      meetingId: m.id,
      participantId: m.participants[0]!.id,
      decision: 'granted',
      noticeRef: notice,
    });
    expect(
      await importMeetingNotes(app.db, owner, {
        meetingId: m.id,
        text: 'Generated notes version one',
      }),
    ).toMatchObject({ version: 1 });
    expect(
      await importMeetingNotes(app.db, owner, {
        meetingId: m.id,
        text: 'Generated notes version two',
      }),
    ).toMatchObject({ version: 2 });
    const current = await getMeeting(app.db, owner, m.id);
    expect(current.currentNotes?.text).toBe('Generated notes version two');
    await expect(
      addMeetingParticipant(app.db, owner, {
        meetingId: m.id,
        expectedVersion: current.version,
        participant: { kind: 'external', label: 'Too late' },
      }),
    ).rejects.toEqual(refused('MEETING_PARTICIPANTS_FROZEN'));
  });
  it('does not accept notes or participant changes from an administrator who was not there', async () => {
    const m = await granted();
    await expect(
      importMeetingNotes(app.db, admin, { meetingId: m.id, text: 'Forbidden' }),
    ).rejects.toEqual(refused('FORBIDDEN'));
    await expect(
      addMeetingParticipant(app.db, admin, {
        meetingId: m.id,
        expectedVersion: m.version,
        participant: { kind: 'member', membershipId: admin.membershipId },
      }),
    ).rejects.toEqual(refused('FORBIDDEN'));
  });
  it('bounds note bytes independently of character count and validates meeting inputs', async () => {
    const m = await granted();
    await expect(
      importMeetingNotes(app.db, owner, { meetingId: m.id, text: '\u00e9'.repeat(262145) }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    await expect(
      createMeeting(app.db, owner, { title: '', occurredAt: new Date() }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    await expect(
      createMeeting(app.db, owner, { title: 'Generated', occurredAt: new Date('invalid') }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
  });
  it('rejects foreign participants, stale meeting versions and removal of the organizer', async () => {
    const m = await meeting();
    await expect(
      addMeetingParticipant(app.db, owner, {
        meetingId: m.id,
        expectedVersion: m.version,
        participant: { kind: 'member', membershipId: pair.b.member.context.membershipId },
      }),
    ).rejects.toEqual(refused('NOT_FOUND'));
    await expect(
      addMeetingParticipant(app.db, owner, {
        meetingId: m.id,
        expectedVersion: 0,
        participant: { kind: 'external', label: 'Generated' },
      }),
    ).rejects.toEqual(refused('VERSION_CONFLICT'));
    await expect(
      removeMeetingParticipant(app.db, owner, {
        meetingId: m.id,
        participantId: m.participants[0]!.id,
        expectedVersion: m.version,
      }),
    ).rejects.toEqual(refused('INVALID_STATE'));
  });
  it('removes an unanswered outside participant before notes and advances the meeting version', async () => {
    const m = await meeting();
    const p = await addMeetingParticipant(app.db, owner, {
      meetingId: m.id,
      expectedVersion: m.version,
      participant: { kind: 'external', label: 'Generated' },
    });
    const added = await getMeeting(app.db, owner, m.id);
    await removeMeetingParticipant(app.db, owner, {
      meetingId: m.id,
      participantId: p.id,
      expectedVersion: added.version,
    });
    expect((await getMeeting(app.db, owner, m.id)).version).toBe(added.version + 1);
    expect((await getMeeting(app.db, owner, m.id)).participants).toHaveLength(1);
  });
  it('purges every note in the same withdrawal transaction and refuses any resurrection', async () => {
    const m = await granted();
    await importMeetingNotes(app.db, owner, {
      meetingId: m.id,
      text: 'GENERATED_PURGE_CANARY_ONE',
    });
    await importMeetingNotes(app.db, owner, {
      meetingId: m.id,
      text: 'GENERATED_PURGE_CANARY_TWO',
    });
    expect(
      await recordMeetingConsent(app.db, owner, {
        meetingId: m.id,
        participantId: m.participants[0]!.id,
        decision: 'withdrawn',
        noticeRef: notice,
      }),
    ).toEqual({ consent: 'withdrawn', status: 'purged' });
    const purged = await getMeeting(app.db, owner, m.id);
    expect(purged).toMatchObject({ status: 'purged', title: 'Removed' });
    expect(purged.currentNotes?.text ?? null).toBeNull();
    const facts = await withTenantTx(app.db, owner, async (tx) => ({
      notes: await tx.select().from(meetingNotes).where(eq(meetingNotes.meetingId, m.id)),
      tombstones: await tx
        .select()
        .from(tombstones)
        .where(and(eq(tombstones.targetType, 'meeting'), eq(tombstones.targetId, m.id))),
      events: await tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, m.id)),
      consents: await tx
        .select()
        .from(meetingConsentRecords)
        .where(eq(meetingConsentRecords.meetingId, m.id)),
    }));
    expect(facts.notes).toHaveLength(2);
    expect(facts.notes.every((row) => row.body === null && row.purgedAt !== null)).toBe(true);
    expect(facts.tombstones).toHaveLength(1);
    expect(facts.consents).toHaveLength(2);
    expect(facts.events.map((row) => row.eventType)).toContain('tombstone.recorded');
    expect(JSON.stringify(facts.events)).not.toContain('GENERATED_PURGE_CANARY');
    await expect(
      importMeetingNotes(app.db, owner, { meetingId: m.id, text: 'Resurrect' }),
    ).rejects.toEqual(refused('MEETING_PURGED'));
  });
  it('rolls a purge back in full on a caller transaction failure', async () => {
    const m = await granted();
    await importMeetingNotes(app.db, owner, { meetingId: m.id, text: 'Generated still present' });
    await expect(
      withTenantTx(app.db, owner, async (tx) => {
        await tx.insert(meetingConsentRecords).values({
          organizationId: owner.organizationId,
          meetingId: m.id,
          participantId: m.participants[0]!.id,
          decision: 'withdrawn',
          basis: 'self',
          noticeRef: notice,
          recordedByMembershipId: owner.membershipId,
        });
        await purgeMeetingContentInTx(tx, owner, {
          meetingId: m.id,
          reasonCode: 'CONSENT_WITHDRAWN',
        });
        throw new Error('GENERATED_TRANSACTION_ABORT');
      }),
    ).rejects.toThrow('GENERATED_TRANSACTION_ABORT');
    expect((await getMeeting(app.db, owner, m.id)).currentNotes?.text).toBe(
      'Generated still present',
    );
  });
  it('allows withdrawal after an administrator switches meetings off', async () => {
    const m = await granted();
    await importMeetingNotes(app.db, owner, {
      meetingId: m.id,
      text: 'Generated withdraw after disabling',
    });
    const settings = await getMeetingSettings(app.db, owner);
    await updateMeetingSettings(app.db, owner, {
      enabled: false,
      noticeRef: notice,
      expectedVersion: settings.version,
    });
    try {
      expect(
        await recordMeetingConsent(app.db, owner, {
          meetingId: m.id,
          participantId: m.participants[0]!.id,
          decision: 'withdrawn',
          noticeRef: notice,
        }),
      ).toMatchObject({ status: 'purged' });
    } finally {
      await enable();
    }
  });
  it('reapplies an external meeting tombstone after a restore, without an artifact deletion', async () => {
    const m = await granted();
    await importMeetingNotes(app.db, owner, {
      meetingId: m.id,
      text: 'Generated restored notes must disappear',
    });
    const entry = {
      organizationId: owner.organizationId,
      targetType: 'meeting',
      targetId: m.id,
      deletedAt: new Date(),
    };
    const key = ledgerKeyFor(entry);
    const store = {
      async *listPages(prefix: string) {
        if (key.startsWith(prefix)) yield [key];
      },
      async get() {
        return serializeLedgerEntry(entry);
      },
      async exists() {
        return false;
      },
      async put() {
        throw new Error('NOT_AN_ARTIFACT');
      },
      async delete() {
        throw new Error('NOT_AN_ARTIFACT');
      },
    };
    expect(await countUnappliedTombstones(app.db, store, owner)).toBe(1);
    const result = await reapplyTombstoneLedger(worker.db, store, createServiceContext);
    expect(result).toMatchObject({
      entries: 1,
      tombstonesAdded: 1,
      artifactsRemoved: 0,
      bytesRemoved: 0,
      failed: 0,
    });
    expect((await getMeeting(app.db, owner, m.id)).currentNotes?.text ?? null).toBeNull();
    expect(await countUnappliedTombstones(app.db, store, owner)).toBe(0);
    expect(await reapplyTombstoneLedger(worker.db, store, createServiceContext)).toMatchObject({
      tombstonesAdded: 0,
      failed: 0,
    });
  });

  it('applies the current company MFA policy to meeting administration for an admin', async () => {
    const fresh = await makeTwoTenants(app.db);
    await proveSecondFactor(fresh.a.owner);
    await updateSecurityPolicy(
      app.db,
      fresh.a.owner.context,
      { sessionId: fresh.a.owner.sessionId },
      {
        expectedVersion: 1,
        mfaForAdministration: true,
        mfaMaxAgeSeconds: 900,
        ssoEnforcement: 'optional',
      },
    );
    const input = { enabled: true, noticeRef: notice, expectedVersion: 1 };
    await expect(updateMeetingSettings(app.db, fresh.a.admin.context, input)).rejects.toMatchObject(
      { code: 'MFA_REQUIRED' },
    );
    await proveSecondFactor(fresh.a.admin);
    expect(await updateMeetingSettings(app.db, fresh.a.admin.context, input)).toMatchObject({
      enabled: true,
    });
  });

  it("refuses service callers even if they supply a valid person's IDs", async () => {
    const service = createServiceContext(owner.organizationId);
    for (const run of [
      () => getMeetingSettings(app.db, service),
      () => listMeetings(app.db, service, {}),
      () => createMeeting(app.db, service, { title: 'Generated', occurredAt: new Date() }),
    ])
      await expect(run()).rejects.toEqual(refused('FORBIDDEN'));
  });
});
