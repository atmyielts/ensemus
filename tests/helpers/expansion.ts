// Test seeds for ADR-033 tables, shared by every M11A slice. They go through the real triggers as the application
// role, so a seed can never reach a state the rules forbid. Generated test values only.
import { createHash, randomUUID } from 'node:crypto';
import {
  meetingConsentRecords,
  meetingDerivationRuns,
  meetingNotes,
  meetingParticipants,
  meetingProposedItems,
  meetingProviderApprovals,
  meetings,
  meetingSettings,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { modelProfileRef } from '@ensemus/domain/meeting';
import { eq } from 'drizzle-orm';

export const TEST_NOTICE = 'notice-v1';
export const TEST_TERMS = 'terms-record-1';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Turns meetings on for this tenant, with a person's name on it. */
export function enableMeetings(
  database: AppDatabase,
  context: TenantContext,
  noticeRef = TEST_NOTICE,
) {
  return withTenantTx(database, context, (tx) =>
    tx
      .insert(meetingSettings)
      .values({
        organizationId: context.organizationId,
        enabled: true,
        noticeRef,
        updatedByMembershipId: context.membershipId,
      })
      .onConflictDoUpdate({
        target: meetingSettings.organizationId,
        set: { enabled: true, noticeRef },
      }),
  );
}

/** A meeting with its organizer listed, as createMeeting leaves one. */
export async function seedMeeting(
  database: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof meetings.$inferInsert> = {},
) {
  const id = randomUUID();
  const participantId = randomUUID();
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(meetings).values({
      organizationId: context.organizationId,
      id,
      title: 'A test meeting',
      occurredAt: new Date(),
      organizerMembershipId: context.membershipId,
      ...overrides,
    });
    await tx.insert(meetingParticipants).values({
      organizationId: context.organizationId,
      id: participantId,
      meetingId: id,
      kind: 'member',
      membershipId: overrides.organizerMembershipId ?? context.membershipId,
    });
  });
  return { id, organizerParticipantId: participantId };
}

export function recordConsent(
  database: AppDatabase,
  context: TenantContext,
  input: {
    meetingId: string;
    participantId: string;
    decision?: 'granted' | 'declined' | 'withdrawn';
    basis?: 'self' | 'attested';
    noticeRef?: string;
    recordedByMembershipId?: string;
  },
) {
  return withTenantTx(database, context, (tx) =>
    tx.insert(meetingConsentRecords).values({
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      participantId: input.participantId,
      decision: input.decision ?? 'granted',
      basis: input.basis ?? 'self',
      noticeRef: input.noticeRef ?? TEST_NOTICE,
      recordedByMembershipId: input.recordedByMembershipId ?? context.membershipId,
    }),
  );
}

/** An approval for a model profile, up to confidential, for both purposes, by this person. */
export async function seedModelApproval(
  database: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof meetingProviderApprovals.$inferInsert> = {},
) {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(meetingProviderApprovals).values({
      organizationId: context.organizationId,
      id,
      kind: 'model',
      targetRef: modelProfileRef(randomUUID()),
      purposes: ['summarize', 'extract_items'],
      maxClassification: 'confidential',
      termsRef: TEST_TERMS,
      approvedByMembershipId: context.membershipId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    }),
  );
  return id;
}

/** Notes, for a meeting whose consent is already complete. */
export async function seedNotes(
  database: AppDatabase,
  context: TenantContext,
  input: { meetingId: string; version?: number; text?: string; classification?: string },
) {
  const id = randomUUID();
  const text = input.text ?? 'Nothing here is real.';
  await withTenantTx(database, context, (tx) =>
    tx.insert(meetingNotes).values({
      organizationId: context.organizationId,
      id,
      meetingId: input.meetingId,
      version: input.version ?? 1,
      sourceKind: 'manual',
      body: text,
      bodySha256: sha256(text),
      sizeBytes: Buffer.byteLength(text),
      classification: input.classification ?? 'confidential',
      importedByMembershipId: context.membershipId,
    }),
  );
  return id;
}

/** A consented meeting with notes and an approved provider, ready for a run. */
export async function seedReadyMeeting(database: AppDatabase, context: TenantContext) {
  const meeting = await seedMeeting(database, context);
  await recordConsent(database, context, {
    meetingId: meeting.id,
    participantId: meeting.organizerParticipantId,
  });
  const notesId = await seedNotes(database, context, { meetingId: meeting.id });
  const providerApprovalId = await seedModelApproval(database, context);
  return { ...meeting, notesId, providerApprovalId };
}

export async function seedDerivationRun(
  database: AppDatabase,
  context: TenantContext,
  input: {
    meetingId: string;
    notesId: string;
    providerApprovalId: string;
    purpose?: 'summarize' | 'extract_items';
    status?: 'requested' | 'running';
  },
) {
  const id = randomUUID();
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(meetingDerivationRuns).values({
      organizationId: context.organizationId,
      id,
      meetingId: input.meetingId,
      notesId: input.notesId,
      providerApprovalId: input.providerApprovalId,
      purpose: input.purpose ?? 'extract_items',
      requestedByMembershipId: context.membershipId,
    });
    if (input.status === 'running') {
      await tx
        .update(meetingDerivationRuns)
        .set({ status: 'running', version: 2 })
        .where(eq(meetingDerivationRuns.id, id));
    }
  });
  return id;
}

/** A proposal, from a running run, the only way one can exist. */
export async function seedProposedItem(
  database: AppDatabase,
  context: TenantContext,
  input: {
    meetingId: string;
    runId: string;
    ordinal?: number;
    kind?: 'decision' | 'work';
    classification?: string;
  },
) {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(meetingProposedItems).values({
      organizationId: context.organizationId,
      id,
      meetingId: input.meetingId,
      runId: input.runId,
      ordinal: input.ordinal ?? 1,
      kind: input.kind ?? 'work',
      title: 'Send the plan',
      classification: input.classification ?? 'confidential',
    }),
  );
  return id;
}
