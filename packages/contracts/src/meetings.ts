// Runtime contracts for meetings and summaries (EXP-03, ADR-033 D4 to D7). The request and response shapes
// match docs/specifications/openapi.yaml, and a test keeps their enums equal to @ensemus/domain/meeting.
import { z } from 'zod';

const classification = z.enum(['public', 'internal', 'confidential', 'restricted']);

/** A reference to the organization's own notice. Text belongs to them and never comes here. */
const noticeRef = z.string().trim().min(1).max(200);

export const updateMeetingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  notice_ref: noticeRef.nullable(),
});
export type UpdateMeetingSettingsBody = z.infer<typeof updateMeetingSettingsSchema>;

export const createMeetingSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  occurred_at: z.iso.datetime({ offset: true }),
  /** Left out, it is confidential, since names and terms can be trade secrets. */
  classification: classification.optional(),
});
export type CreateMeetingBody = z.infer<typeof createMeetingSchema>;

/** Starts a meeting from something a connector found, by its resource ID in this tenant. */
export const createMeetingFromResourceSchema = z.strictObject({
  resource_id: z.uuid(),
  title: z.string().trim().min(1).max(300),
  occurred_at: z.iso.datetime({ offset: true }),
  classification: classification.optional(),
});
export type CreateMeetingFromResourceBody = z.infer<typeof createMeetingFromResourceSchema>;

export const addParticipantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), membership_id: z.uuid() }),
  /** A name for the organizer's list. It is not an address, and nothing contacts them through it. */
  z.strictObject({ kind: z.literal('external'), label: z.string().trim().min(1).max(200) }),
]);
export type AddParticipantBody = z.infer<typeof addParticipantSchema>;

export const recordConsentSchema = z.strictObject({
  decision: z.enum(['granted', 'declined', 'withdrawn']),
  /** Which notice the page showed. If it is no longer current, nothing is recorded. */
  notice_ref: noticeRef,
});
export type RecordConsentBody = z.infer<typeof recordConsentSchema>;

/** Plain text, up to MAX_NOTES_BYTES when measured as bytes. */
export const importNotesSchema = z.strictObject({ text: z.string().min(1).max(524_288) });
export type ImportNotesBody = z.infer<typeof importNotesSchema>;

export const approveProviderSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('model'),
    model_profile_id: z.uuid(),
    purposes: z
      .array(z.enum(['summarize', 'extract_items']))
      .min(1)
      .max(2),
    max_classification: z.enum(['public', 'internal', 'confidential']),
    /** A reference to the organization's record of the basis. It holds no terms. */
    terms_ref: z.string().trim().min(1).max(200),
    expires_at: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal('source'),
    connection_id: z.uuid(),
    max_classification: z.enum(['public', 'internal', 'confidential']),
    terms_ref: z.string().trim().min(1).max(200),
    expires_at: z.iso.datetime({ offset: true }),
  }),
]);
export type ApproveProviderBody = z.infer<typeof approveProviderSchema>;

export const requestDerivationSchema = z.strictObject({
  purpose: z.enum(['summarize', 'extract_items']),
  provider_approval_id: z.uuid(),
});
export type RequestDerivationBody = z.infer<typeof requestDerivationSchema>;

export const requestNotesImportSchema = z.strictObject({ provider_approval_id: z.uuid() });
export type RequestNotesImportBody = z.infer<typeof requestNotesImportSchema>;

/**
 * Accepting a proposal is a person's act, so everything that lands on the Work Unit comes from this body and
 * not from what the model suggested. The page starts it filled in, and they can change all of it.
 */
export const acceptProposedWorkSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().max(10_000).optional(),
  owner_membership_id: z.uuid(),
  due_at: z.iso.datetime({ offset: true }).nullable(),
});
export type AcceptProposedWorkBody = z.infer<typeof acceptProposedWorkSchema>;

export const decideProposedItemSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type DecideProposedItemBody = z.infer<typeof decideProposedItemSchema>;

export const reassignOrganizerSchema = z.strictObject({ organizer_membership_id: z.uuid() });
export type ReassignOrganizerBody = z.infer<typeof reassignOrganizerSchema>;

/**
 * What a model may hand back. It came from a model that read a stranger's words, so it is data and nothing
 * else: strict shapes, bounded text, participant references by the opaque numbers it was given, and no ID,
 * URL or instruction field for it to fill in (security blueprint, agent safety).
 */
export const meetingSummaryOutputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(100_000),
});
export type MeetingSummaryOutput = z.infer<typeof meetingSummaryOutputSchema>;

export const meetingItemsOutputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        kind: z.enum(['decision', 'work']),
        title: z.string().trim().min(1).max(300),
        detail: z.string().trim().min(1).max(4000).optional(),
        /** The position of a participant in the list given to the model, from 1. */
        suggested_participant: z.int().min(1).max(200).optional(),
        suggested_due_on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .max(100),
});
export type MeetingItemsOutput = z.infer<typeof meetingItemsOutputSchema>;
