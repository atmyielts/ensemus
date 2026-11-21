// ADR-033's database rules on their own: forced RLS, what each role can reach, and the triggers that hold consent,
// provider approval and "proposed, never applied" whatever application code does. Real PostgreSQL, real roles.
// The slices test behaviour on top of this. Written in code-only mode: it has not run yet, and 0600 and 0601 have
// to be in the migration journal first, which the final merge does.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessRecords,
  createOrganization,
  externalResources,
  meetingConsentRecords,
  meetingDerivationRuns,
  meetingImportRequests,
  meetingNotes,
  meetingParticipants,
  meetingProposedItems,
  meetingProviderApprovals,
  meetings,
  meetingSettings,
  meetingSummaries,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createWorkUnit } from '@ensemus/application';
import { modelProfileRef } from '@ensemus/domain/meeting';
import { eq } from 'drizzle-orm';
import {
  enableMeetings,
  recordConsent,
  seedDerivationRun,
  seedMeeting,
  seedModelApproval,
  seedNotes,
  seedProposedItem,
  seedReadyMeeting,
  TEST_NOTICE,
  TEST_TERMS,
} from '../helpers/expansion';
import { seedConnection } from '../helpers/integrations';
import { urls } from '../helpers/stack';

const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });
const CONSENT = 'EN110';
const PROVIDER = 'EN111';
const STATE = 'EN112';
const ITEM = 'EN113';
const NOT_PERMITTED = '42501';

describe('expansion rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let su: pg.Client;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  let memberA: TenantContext;
  let outsiderA: TenantContext;

  const db = () => database.db;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const addMember = async (organizationId: string, label: string) => {
    const userId = await makeUser(label);
    await su.query(
      `insert into org.memberships (organization_id, id, user_id, role, status) values ($1, $2, $3, 'member', 'active')`,
      [organizationId, randomUUID(), userId],
    );
    return resolveTenantContext(db(), userId, organizationId);
  };

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = await client(urls.auth());
    su = await client(urls.superuser());
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const orgA = await createOrganization(db(), {
      userId: alice,
      name: 'Same Name Ltd',
      commercialMode: 'cloud',
    });
    const orgB = await createOrganization(db(), {
      userId: bob,
      name: 'Same Name Ltd',
      commercialMode: 'cloud',
    });
    ctxA = await resolveTenantContext(db(), alice, orgA.organizationId);
    ctxB = await resolveTenantContext(db(), bob, orgB.organizationId);
    memberA = await addMember(orgA.organizationId, 'carol');
    outsiderA = await addMember(orgA.organizationId, 'dave');
    await enableMeetings(db(), ctxA);
    await enableMeetings(db(), ctxB);
  });

  afterAll(async () => {
    await database.close();
    await auth.end();
    await su.end();
  });

  describe('row-level security', () => {
    it('hides another tenant’s rows, with the same names', async () => {
      const mine = await seedMeeting(db(), ctxA, { title: 'Same title' });
      const theirs = await seedMeeting(db(), ctxB, { title: 'Same title' });
      const seen = await withTenantTx(db(), ctxA, (tx) => tx.select().from(meetings));
      expect(seen.map((row) => row.id)).toContain(mine.id);
      expect(seen.map((row) => row.id)).not.toContain(theirs.id);
    });

    it('returns nothing at all with no tenant bound', async () => {
      await seedMeeting(db(), ctxA);
      for (const table of [
        meetings,
        meetingSettings,
        meetingParticipants,
        meetingConsentRecords,
        meetingProviderApprovals,
        meetingNotes,
        meetingDerivationRuns,
        meetingSummaries,
        meetingProposedItems,
        meetingImportRequests,
        businessRecords,
      ]) {
        expect(await db().run((tx) => tx.select().from(table))).toEqual([]);
      }
    });

    it('refuses to write a row into another tenant', async () => {
      // A meeting of theirs, named by a caller bound to this tenant. Whichever check gets there first.
      const theirs = await seedMeeting(db(), ctxB);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingParticipants).values({
            organizationId: ctxB.organizationId,
            meetingId: theirs.id,
            kind: 'external',
            externalLabel: 'Someone',
          }),
        ),
      ).rejects.toThrow();
      const inTheirs = await withTenantTx(db(), ctxB, (tx) =>
        tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, theirs.id)),
      );
      expect(inTheirs).toHaveLength(1);
    });

    it('refuses to point at another tenant’s meeting, membership or approval', async () => {
      const theirs = await seedMeeting(db(), ctxB);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingParticipants).values({
            organizationId: ctxA.organizationId,
            meetingId: theirs.id,
            kind: 'external',
            externalLabel: 'Someone',
          }),
        ),
      ).rejects.toEqual(sqlState(STATE));
      const mine = await seedMeeting(db(), ctxA);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingParticipants).values({
            organizationId: ctxA.organizationId,
            meetingId: mine.id,
            kind: 'member',
            membershipId: ctxB.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('23503'));
    });

    it('gives the dispatcher, auth and secrets roles nothing here', async () => {
      const { rows } = await su.query(
        `select grantee, table_schema, table_name from information_schema.role_table_grants
          where grantee in ('ensemus_dispatcher','ensemus_auth','ensemus_secrets')
            and (table_schema = 'meetings'
                 or (table_schema = 'integrations' and table_name like 'business_record%'))`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('what cannot be changed by any application code', () => {
    it('keeps a meeting’s class and source', async () => {
      const meeting = await seedMeeting(db(), ctxA);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.update(meetings).set({ classification: 'public' }).where(eq(meetings.id, meeting.id)),
        ),
      ).rejects.toEqual(sqlState(NOT_PERMITTED));
    });

    it('keeps consent records as written', async () => {
      const meeting = await seedMeeting(db(), ctxA);
      await recordConsent(db(), ctxA, {
        meetingId: meeting.id,
        participantId: meeting.organizerParticipantId,
      });
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingConsentRecords)
            .set({ decision: 'declined' })
            .where(eq(meetingConsentRecords.meetingId, meeting.id)),
        ),
      ).rejects.toThrow();
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.delete(meetingConsentRecords).where(eq(meetingConsentRecords.meetingId, meeting.id)),
        ),
      ).rejects.toThrow();
    });

    it('keeps an approval as written, and lets it be revoked once', async () => {
      const id = await seedModelApproval(db(), ctxA);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingProviderApprovals)
            .set({ maxClassification: 'confidential', expiresAt: new Date(2100, 1, 1) })
            .where(eq(meetingProviderApprovals.id, id)),
        ),
      ).rejects.toEqual(sqlState(NOT_PERMITTED));
      const revoke = () =>
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingProviderApprovals)
            .set({ revokedAt: new Date(), revokedByMembershipId: ctxA.membershipId })
            .where(eq(meetingProviderApprovals.id, id)),
        );
      await revoke();
      await expect(revoke()).rejects.toEqual(sqlState(PROVIDER));
    });
  });

  describe('turning meetings on', () => {
    it('refuses a meeting until an administrator has turned them on', async () => {
      const erin = await makeUser('erin');
      const org = await createOrganization(db(), {
        userId: erin,
        name: 'Never Enabled Ltd',
        commercialMode: 'cloud',
      });
      const context = await resolveTenantContext(db(), erin, org.organizationId);
      await expect(seedMeeting(db(), context)).rejects.toEqual(sqlState(CONSENT));
    });

    it('needs a notice to be on', async () => {
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingSettings)
            .set({ enabled: true, noticeRef: null })
            .where(eq(meetingSettings.organizationId, ctxA.organizationId)),
        ),
      ).rejects.toEqual(sqlState('23514'));
    });
  });

  describe('consent', () => {
    const attempt = (context: TenantContext, meetingId: string, participantId: string) =>
      recordConsent(db(), context, { meetingId, participantId });

    it('lets a member speak for themselves, and nobody for them', async () => {
      const meeting = await seedMeeting(db(), ctxA);
      const participantId = randomUUID();
      await withTenantTx(db(), ctxA, (tx) =>
        tx.insert(meetingParticipants).values({
          organizationId: ctxA.organizationId,
          id: participantId,
          meetingId: meeting.id,
          kind: 'member',
          membershipId: memberA.membershipId,
        }),
      );
      // The organizer tries, and an owner of the organization tries, both as `self` and as `attested`.
      await expect(attempt(ctxA, meeting.id, participantId)).rejects.toEqual(sqlState(CONSENT));
      await expect(
        recordConsent(db(), ctxA, { meetingId: meeting.id, participantId, basis: 'attested' }),
      ).rejects.toEqual(sqlState(CONSENT));
      await attempt(memberA, meeting.id, participantId);
    });

    it('lets the organizer attest for someone outside, and only them', async () => {
      const meeting = await seedMeeting(db(), ctxA);
      const participantId = randomUUID();
      await withTenantTx(db(), ctxA, (tx) =>
        tx.insert(meetingParticipants).values({
          organizationId: ctxA.organizationId,
          id: participantId,
          meetingId: meeting.id,
          kind: 'external',
          externalLabel: 'A visitor',
        }),
      );
      await expect(
        recordConsent(db(), memberA, { meetingId: meeting.id, participantId, basis: 'attested' }),
      ).rejects.toEqual(sqlState(CONSENT));
      await expect(attempt(ctxA, meeting.id, participantId)).rejects.toEqual(sqlState(CONSENT));
      await recordConsent(db(), ctxA, { meetingId: meeting.id, participantId, basis: 'attested' });
    });

    it('refuses an answer to a notice that is no longer current', async () => {
      const meeting = await seedMeeting(db(), ctxA);
      await expect(
        recordConsent(db(), ctxA, {
          meetingId: meeting.id,
          participantId: meeting.organizerParticipantId,
          noticeRef: `${TEST_NOTICE}-old`,
        }),
      ).rejects.toEqual(sqlState(CONSENT));
    });

    it('refuses a participant from another meeting', async () => {
      const one = await seedMeeting(db(), ctxA);
      const two = await seedMeeting(db(), ctxA);
      await expect(attempt(ctxA, one.id, two.organizerParticipantId)).rejects.toThrow();
    });

    it('refuses notes until everyone has agreed, and takes the newest word', async () => {
      const meeting = await seedMeeting(db(), ctxA);
      const participantId = meeting.organizerParticipantId;
      await expect(seedNotes(db(), ctxA, { meetingId: meeting.id })).rejects.toEqual(
        sqlState(CONSENT),
      );
      await recordConsent(db(), ctxA, {
        meetingId: meeting.id,
        participantId,
        decision: 'declined',
      });
      await expect(seedNotes(db(), ctxA, { meetingId: meeting.id })).rejects.toEqual(
        sqlState(CONSENT),
      );
      await recordConsent(db(), ctxA, { meetingId: meeting.id, participantId });
      await seedNotes(db(), ctxA, { meetingId: meeting.id });
    });

    it('fixes who was there once notes exist', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingParticipants).values({
            organizationId: ctxA.organizationId,
            meetingId: ready.id,
            kind: 'external',
            externalLabel: 'Late arrival',
          }),
        ),
      ).rejects.toEqual(sqlState(STATE));
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .delete(meetingParticipants)
            .where(eq(meetingParticipants.id, ready.organizerParticipantId)),
        ),
      ).rejects.toEqual(sqlState(STATE));
    });

    it('makes someone withdraw, rather than decline, once notes exist', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      await expect(
        recordConsent(db(), ctxA, {
          meetingId: ready.id,
          participantId: ready.organizerParticipantId,
          decision: 'declined',
        }),
      ).rejects.toEqual(sqlState(CONSENT));
    });

    it('will not commit a withdrawal that leaves the content there', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      await expect(
        recordConsent(db(), ctxA, {
          meetingId: ready.id,
          participantId: ready.organizerParticipantId,
          decision: 'withdrawn',
        }),
      ).rejects.toEqual(sqlState(CONSENT));
      const [notes] = await withTenantTx(db(), ctxA, (tx) =>
        tx.select().from(meetingNotes).where(eq(meetingNotes.id, ready.notesId)),
      );
      expect(notes?.body).not.toBeNull();
    });

    it('commits a withdrawal and a purge together, and that is the end of the meeting', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      await withTenantTx(db(), ctxA, async (tx) => {
        await tx.insert(meetingConsentRecords).values({
          organizationId: ctxA.organizationId,
          meetingId: ready.id,
          participantId: ready.organizerParticipantId,
          decision: 'withdrawn',
          basis: 'self',
          noticeRef: TEST_NOTICE,
          recordedByMembershipId: ctxA.membershipId,
        });
        await tx
          .update(meetingNotes)
          .set({ body: null })
          .where(eq(meetingNotes.meetingId, ready.id));
        await tx.update(meetings).set({ status: 'purged' }).where(eq(meetings.id, ready.id));
      });
      const [meeting] = await withTenantTx(db(), ctxA, (tx) =>
        tx.select().from(meetings).where(eq(meetings.id, ready.id)),
      );
      expect(meeting?.title).toBe('Removed');
      expect(meeting?.purgedAt).not.toBeNull();
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.update(meetings).set({ status: 'open' }).where(eq(meetings.id, ready.id)),
        ),
      ).rejects.toEqual(sqlState(STATE));
      await expect(seedNotes(db(), ctxA, { meetingId: ready.id, version: 2 })).rejects.toEqual(
        sqlState(STATE),
      );
    });

    it('lets text go and never lets it change or come back', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const write = (body: string | null) =>
        withTenantTx(db(), ctxA, (tx) =>
          tx.update(meetingNotes).set({ body }).where(eq(meetingNotes.id, ready.notesId)),
        );
      await expect(write('Something else')).rejects.toEqual(sqlState(STATE));
      await write(null);
      await expect(write('It came back')).rejects.toEqual(sqlState(STATE));
    });
  });

  describe('provider approval', () => {
    const approvalValues = () => ({
      organizationId: ctxA.organizationId,
      kind: 'model',
      targetRef: modelProfileRef(randomUUID()),
      purposes: ['summarize'],
      maxClassification: 'internal',
      termsRef: TEST_TERMS,
      approvedByMembershipId: ctxA.membershipId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    it('takes an active owner or admin', async () => {
      await expect(
        withTenantTx(db(), memberA, (tx) =>
          tx
            .insert(meetingProviderApprovals)
            .values({ ...approvalValues(), approvedByMembershipId: memberA.membershipId }),
        ),
      ).rejects.toEqual(sqlState(PROVIDER));
    });

    it.each([
      ['restricted', { maxClassification: 'restricted' }],
      ['a purpose a model has no business with', { purposes: ['import_notes'] }],
      ['no purpose', { purposes: [] }],
      ['a model under a connection’s name', { targetRef: `connection:${randomUUID()}` }],
      ['no terms reference', { termsRef: '' }],
      ['an approval that has already expired', { expiresAt: new Date(2000, 1, 1) }],
    ])('refuses %s', async (_name, change) => {
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingProviderApprovals).values({ ...approvalValues(), ...change }),
        ),
      ).rejects.toEqual(sqlState('23514'));
    });

    it('refuses a connection that is not in this tenant', async () => {
      const theirs = await seedConnection(db(), ctxB);
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingProviderApprovals).values({
            ...approvalValues(),
            kind: 'source',
            targetRef: `connection:${theirs}`,
            purposes: ['import_notes'],
          }),
        ),
      ).rejects.toEqual(sqlState(PROVIDER));
    });

    describe('for a run', () => {
      const run = (
        ready: Awaited<ReturnType<typeof seedReadyMeeting>>,
        overrides: { providerApprovalId?: string; purpose?: 'summarize' | 'extract_items' } = {},
      ) =>
        seedDerivationRun(db(), ctxA, {
          meetingId: ready.id,
          notesId: ready.notesId,
          providerApprovalId: ready.providerApprovalId,
          ...overrides,
        });

      it('needs an approval', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        await expect(run(ready, { providerApprovalId: randomUUID() })).rejects.toThrow();
      });

      it('needs it for this purpose', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        const approval = await seedModelApproval(db(), ctxA, { purposes: ['summarize'] });
        await expect(
          run(ready, { providerApprovalId: approval, purpose: 'extract_items' }),
        ).rejects.toEqual(sqlState(PROVIDER));
      });

      it('needs it unexpired and not revoked', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        const revoked = await seedModelApproval(db(), ctxA);
        await withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingProviderApprovals)
            .set({ revokedAt: new Date(), revokedByMembershipId: ctxA.membershipId })
            .where(eq(meetingProviderApprovals.id, revoked)),
        );
        await expect(run(ready, { providerApprovalId: revoked })).rejects.toEqual(
          sqlState(PROVIDER),
        );
      });

      it('needs it to cover this class', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        const lower = await seedModelApproval(db(), ctxA, { maxClassification: 'internal' });
        await expect(run(ready, { providerApprovalId: lower })).rejects.toEqual(sqlState(PROVIDER));
      });

      it('never passes restricted content, whatever the approval says', async () => {
        const meeting = await seedMeeting(db(), ctxA, { classification: 'restricted' });
        await recordConsent(db(), ctxA, {
          meetingId: meeting.id,
          participantId: meeting.organizerParticipantId,
        });
        const notesId = await seedNotes(db(), ctxA, {
          meetingId: meeting.id,
          classification: 'restricted',
        });
        const approval = await seedModelApproval(db(), ctxA);
        await expect(
          seedDerivationRun(db(), ctxA, {
            meetingId: meeting.id,
            notesId,
            providerApprovalId: approval,
          }),
        ).rejects.toEqual(sqlState(PROVIDER));
      });

      it('needs the newest notes', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        await seedNotes(db(), ctxA, { meetingId: ready.id, version: 2, text: 'Corrected.' });
        await expect(run(ready)).rejects.toEqual(sqlState(STATE));
      });

      it('allows one open run for the same notes and purpose', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        await run(ready);
        await expect(run(ready)).rejects.toEqual(sqlState('23505'));
      });

      it('rechecks when the worker is about to go', async () => {
        const ready = await seedReadyMeeting(db(), ctxA);
        const id = await run(ready);
        await withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingProviderApprovals)
            .set({ revokedAt: new Date(), revokedByMembershipId: ctxA.membershipId })
            .where(eq(meetingProviderApprovals.id, ready.providerApprovalId)),
        );
        await expect(
          withTenantTx(db(), ctxA, (tx) =>
            tx
              .update(meetingDerivationRuns)
              .set({ status: 'running' })
              .where(eq(meetingDerivationRuns.id, id)),
          ),
        ).rejects.toEqual(sqlState(PROVIDER));
      });

      it.each([
        ['requested', 'completed'],
        ['requested', 'requested_again'],
      ])('refuses the jump from %s to %s', async (_from, to) => {
        const ready = await seedReadyMeeting(db(), ctxA);
        const id = await run(ready);
        await expect(
          withTenantTx(db(), ctxA, (tx) =>
            tx
              .update(meetingDerivationRuns)
              .set({ status: to })
              .where(eq(meetingDerivationRuns.id, id)),
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe('what a model produced', () => {
    it('can arrive only during its own run, for what that run is for', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const requested = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
      });
      await expect(
        seedProposedItem(db(), ctxA, { meetingId: ready.id, runId: requested }),
      ).rejects.toEqual(sqlState(STATE));
      const summarizing = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
        purpose: 'summarize',
        status: 'running',
      });
      await expect(
        seedProposedItem(db(), ctxA, { meetingId: ready.id, runId: summarizing }),
      ).rejects.toEqual(sqlState(STATE));
    });

    it('keeps its source’s class, and no less', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const runId = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
        status: 'running',
      });
      await expect(
        seedProposedItem(db(), ctxA, { meetingId: ready.id, runId, classification: 'public' }),
      ).rejects.toEqual(sqlState(STATE));
    });

    it('has to say it is a model’s', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const runId = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
        purpose: 'summarize',
        status: 'running',
      });
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingSummaries).values({
            organizationId: ctxA.organizationId,
            meetingId: ready.id,
            runId,
            body: 'A summary',
            classification: 'confidential',
            trust: 'verified',
            sourceNotesSha256: 'a'.repeat(64),
          }),
        ),
      ).rejects.toEqual(sqlState('23514'));
    });
  });

  describe('proposed, never applied (ADR-033 D7)', () => {
    const readyItem = async (kind: 'decision' | 'work' = 'work') => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const runId = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
        status: 'running',
      });
      const id = await seedProposedItem(db(), ctxA, { meetingId: ready.id, runId, kind });
      return { ...ready, runId, itemId: id };
    };
    const work = () =>
      createWorkUnit(db(), ctxA, { title: 'Send the plan', objective: 'Send it.' });

    it.each([
      ['accepted already', { status: 'accepted' }],
      ['rejected already', { status: 'rejected' }],
      ['with a decider', () => ({ decidedByMembershipId: ctxA.membershipId })],
      ['with a decision time', { decidedAt: new Date() }],
    ])('refuses a proposal that starts %s', async (_name, change) => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const runId = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
        status: 'running',
      });
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingProposedItems).values({
            organizationId: ctxA.organizationId,
            meetingId: ready.id,
            runId,
            ordinal: 1,
            kind: 'work',
            title: 'Send the plan',
            classification: 'confidential',
            ...(typeof change === 'function' ? change() : change),
          }),
        ),
      ).rejects.toEqual(sqlState(ITEM));
    });

    it('refuses one that starts with a Work Unit behind it', async () => {
      const ready = await seedReadyMeeting(db(), ctxA);
      const runId = await seedDerivationRun(db(), ctxA, {
        meetingId: ready.id,
        notesId: ready.notesId,
        providerApprovalId: ready.providerApprovalId,
        status: 'running',
      });
      const unit = await work();
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingProposedItems).values({
            organizationId: ctxA.organizationId,
            meetingId: ready.id,
            runId,
            ordinal: 1,
            kind: 'work',
            title: 'Send the plan',
            classification: 'confidential',
            workUnitId: unit.id,
          }),
        ),
      ).rejects.toEqual(sqlState(ITEM));
    });

    const accept = (itemId: string, change: Partial<typeof meetingProposedItems.$inferInsert>) =>
      withTenantTx(db(), ctxA, (tx) =>
        tx
          .update(meetingProposedItems)
          .set({ status: 'accepted', decidedAt: new Date(), ...change })
          .where(eq(meetingProposedItems.id, itemId)),
      );

    it('takes a named person to accept it, with no name meaning no', async () => {
      const { itemId } = await readyItem();
      const unit = await work();
      await expect(accept(itemId, { workUnitId: unit.id })).rejects.toEqual(sqlState(ITEM));
    });

    it('takes someone who was in the room', async () => {
      const { itemId } = await readyItem();
      const unit = await work();
      await expect(
        accept(itemId, { workUnitId: unit.id, decidedByMembershipId: outsiderA.membershipId }),
      ).rejects.toEqual(sqlState(ITEM));
    });

    it('takes a Work Unit behind accepted work', async () => {
      const { itemId } = await readyItem();
      await expect(accept(itemId, { decidedByMembershipId: ctxA.membershipId })).rejects.toEqual(
        sqlState(ITEM),
      );
    });

    it('accepts a person’s decision, once, and it cannot be taken back', async () => {
      const { itemId } = await readyItem();
      const unit = await work();
      await accept(itemId, { workUnitId: unit.id, decidedByMembershipId: ctxA.membershipId });
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingProposedItems)
            .set({ status: 'rejected', decidedByMembershipId: ctxA.membershipId })
            .where(eq(meetingProposedItems.id, itemId)),
        ),
      ).rejects.toEqual(sqlState(ITEM));
    });

    it('lets one Work Unit answer for one proposal', async () => {
      const first = await readyItem();
      const second = await readyItem();
      const unit = await work();
      await accept(first.itemId, { workUnitId: unit.id, decidedByMembershipId: ctxA.membershipId });
      await expect(
        accept(second.itemId, { workUnitId: unit.id, decidedByMembershipId: ctxA.membershipId }),
      ).rejects.toEqual(sqlState('23505'));
    });

    it('never gives a decision a Work Unit', async () => {
      const { itemId } = await readyItem('decision');
      const unit = await work();
      await expect(
        accept(itemId, { workUnitId: unit.id, decidedByMembershipId: ctxA.membershipId }),
      ).rejects.toEqual(sqlState(ITEM));
      await accept(itemId, { decidedByMembershipId: ctxA.membershipId });
    });

    it('lets its text go and never change', async () => {
      const { itemId } = await readyItem();
      const write = (title: string | null) =>
        withTenantTx(db(), ctxA, (tx) =>
          tx.update(meetingProposedItems).set({ title }).where(eq(meetingProposedItems.id, itemId)),
        );
      await expect(write('Something the model never said')).rejects.toEqual(sqlState(ITEM));
      await write(null);
    });

    it('withdraws with nobody’s name on it, only with its text gone', async () => {
      const { itemId } = await readyItem();
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx
            .update(meetingProposedItems)
            .set({ status: 'withdrawn' })
            .where(eq(meetingProposedItems.id, itemId)),
        ),
      ).rejects.toEqual(sqlState(ITEM));
      await withTenantTx(db(), ctxA, (tx) =>
        tx
          .update(meetingProposedItems)
          .set({ status: 'withdrawn', title: null, detail: null })
          .where(eq(meetingProposedItems.id, itemId)),
      );
    });
  });

  describe('reading notes from a source', () => {
    it('needs an approved connection, and the one the meeting came from', async () => {
      const connectionId = await seedConnection(db(), ctxA, {
        connectorType: 'meeting_notes_http',
      });
      const other = await seedConnection(db(), ctxA, { connectorType: 'meeting_notes_http' });
      const resourceId = randomUUID();
      await withTenantTx(db(), ctxA, (tx) =>
        tx.insert(externalResources).values({
          organizationId: ctxA.organizationId,
          id: resourceId,
          connectionId,
          resourceType: 'meetings.notes',
          externalId: 'note-1',
        }),
      );
      const meeting = await seedMeeting(db(), ctxA, {
        sourceKind: 'connector',
        connectionId,
        sourceResourceId: resourceId,
      });
      const importRequest = (sourceApprovalId: string) =>
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingImportRequests).values({
            organizationId: ctxA.organizationId,
            meetingId: meeting.id,
            sourceApprovalId,
            requestedByMembershipId: ctxA.membershipId,
          }),
        );
      const approve = async (target: string) => {
        const id = randomUUID();
        await withTenantTx(db(), ctxA, (tx) =>
          tx.insert(meetingProviderApprovals).values({
            organizationId: ctxA.organizationId,
            id,
            kind: 'source',
            targetRef: `connection:${target}`,
            purposes: ['import_notes'],
            maxClassification: 'confidential',
            termsRef: TEST_TERMS,
            approvedByMembershipId: ctxA.membershipId,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        );
        return id;
      };
      const right = await approve(connectionId);
      const wrong = await approve(other);
      await expect(importRequest(right)).rejects.toEqual(sqlState(CONSENT));
      await recordConsent(db(), ctxA, {
        meetingId: meeting.id,
        participantId: meeting.organizerParticipantId,
      });
      await expect(importRequest(wrong)).rejects.toEqual(sqlState(PROVIDER));
      await importRequest(right);
    });
  });

  describe('stored business records', () => {
    it('refuse what the checks refuse', async () => {
      const connectionId = await seedConnection(db(), ctxA, { connectorType: 'crm_http' });
      const values = {
        organizationId: ctxA.organizationId,
        connectionId,
        stream: 'crm.deals',
        externalId: randomUUID(),
        fields: {},
        fieldsSha256: 'a'.repeat(64),
        classification: 'internal',
      };
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(businessRecords).values({ ...values, classification: 'secret' }),
        ),
      ).rejects.toEqual(sqlState('23514'));
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(businessRecords).values({ ...values, fields: { big: 'x'.repeat(70_000) } }),
        ),
      ).rejects.toEqual(sqlState('23514'));
      await withTenantTx(db(), ctxA, (tx) => tx.insert(businessRecords).values(values));
      await expect(
        withTenantTx(db(), ctxA, (tx) => tx.insert(businessRecords).values(values)),
      ).rejects.toEqual(sqlState('23505'));
    });

    it('refuse another tenant’s connection, and any change to their source', async () => {
      const theirs = await seedConnection(db(), ctxB, { connectorType: 'crm_http' });
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.insert(businessRecords).values({
            organizationId: ctxA.organizationId,
            connectionId: theirs,
            stream: 'crm.deals',
            externalId: randomUUID(),
            fields: {},
            fieldsSha256: 'a'.repeat(64),
            classification: 'internal',
          }),
        ),
      ).rejects.toEqual(sqlState('23503'));
      await expect(
        withTenantTx(db(), ctxA, (tx) =>
          tx.update(businessRecords).set({ stream: 'crm.contacts' }),
        ),
      ).rejects.toEqual(sqlState(NOT_PERMITTED));
    });
  });

  it('has a member row for each test person', async () => {
    const seen = await withTenantTx(db(), ctxA, (tx) => tx.select().from(memberships));
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });
});
