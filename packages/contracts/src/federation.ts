// Runtime contracts for cross-organization work (ADR-035). The request and response shapes match
// docs/specifications/openapi.yaml, and tests/unit/federation-rules.test.ts keeps their enums the same as the
// domain and the tables. Every shape is strict: only the fields named here can ever cross.
import { z } from 'zod';

const FEDERATION_NOTE_MAX = 2000;

export const federationGrantStatusSchema = z.enum(['proposed', 'accepted', 'active', 'ended']);
export const federationEndReasonSchema = z.enum([
  'cancelled',
  'declined',
  'revoked',
  'expired',
  'disabled',
]);
export const federationPurposeSchema = z.enum(['delegated_work', 'document_review']);
export const federationItemKindSchema = z.enum(['work_summary', 'artifact', 'status_update']);
export const federationClassificationSchema = z.enum(['public', 'internal', 'confidential']);
export const federationItemStateSchema = z.enum(['queued', 'delivered', 'refused', 'withdrawn']);
export const federationDispositionSchema = z.enum(['pending', 'accepted', 'rejected']);

export const setFederationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  expected_version: z.int().min(0),
});
export type SetFederationSettingsBody = z.infer<typeof setFederationSettingsSchema>;

/** An owner offers this. Nothing else can name a purpose, a limit or a date. */
export const proposeGrantSchema = z.strictObject({
  purpose: federationPurposeSchema,
  max_classification: federationClassificationSchema,
  /** Checked against the limits in @ensemus/domain/federation, on the server. */
  expires_in_days: z.int().min(1).max(365),
  invitation_expires_in_days: z.int().min(1).max(14),
  note: z.string().trim().min(1).max(FEDERATION_NOTE_MAX).optional(),
});
export type ProposeGrantBody = z.infer<typeof proposeGrantSchema>;

/** The token goes in a body, never a URL, so it stays out of logs and history. */
export const redeemInvitationSchema = z.strictObject({
  token: z.string().min(16).max(256),
});
export type RedeemInvitationBody = z.infer<typeof redeemInvitationSchema>;

const termsHash = z.string().regex(/^[0-9a-f]{64}$/);

/** Consent names the exact terms the person read. A different hash is refused. */
export const acceptInvitationSchema = z.strictObject({
  token: z.string().min(16).max(256),
  terms_hash: termsHash,
});
export type AcceptInvitationBody = z.infer<typeof acceptInvitationSchema>;

export const confirmGrantSchema = z.strictObject({
  terms_hash: termsHash,
  expected_version: z.int().min(1),
});
export type ConfirmGrantBody = z.infer<typeof confirmGrantSchema>;

export const endGrantSchema = z.strictObject({
  reason: z.enum(['cancelled', 'declined', 'revoked']),
  expected_version: z.int().min(1),
});
export type EndGrantBody = z.infer<typeof endGrantSchema>;

/**
 * What crosses, per kind. These are copies a person chose to send, with only these fields. Nothing else of
 * the Work Unit or the file goes: no owner, no assignee, no comment, no ID from the sender's tenant.
 */
export const workSummaryBodySchema = z.strictObject({
  objective: z.string().trim().min(1).max(20_000).optional(),
  completion_criteria: z.string().trim().min(1).max(20_000).optional(),
  due_at: z.iso.datetime({ offset: true }).optional(),
});
export type WorkSummaryBody = z.infer<typeof workSummaryBodySchema>;

export const statusUpdateBodySchema = z.strictObject({
  state: z.enum(['received', 'in_progress', 'blocked', 'completed', 'declined']),
  note: z.string().trim().min(1).max(FEDERATION_NOTE_MAX).optional(),
});
export type StatusUpdateBody = z.infer<typeof statusUpdateBodySchema>;

/** A file carries nothing in its body. Its name is the title, and its bytes are copied by a worker. */
export const artifactBodySchema = z.strictObject({});

const itemTitle = z.string().trim().min(1).max(200);

export const publishItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('work_summary'),
    /** The sender's own Work Unit. Its classification comes from the row, never from this. */
    work_unit_id: z.uuid(),
    title: itemTitle,
    body: workSummaryBodySchema,
  }),
  z.strictObject({
    kind: z.literal('artifact'),
    /** The sender's own artifact. Its classification, hash and type come from the row. */
    artifact_id: z.uuid(),
    title: itemTitle,
  }),
  z.strictObject({
    kind: z.literal('status_update'),
    title: itemTitle,
    body: statusUpdateBodySchema,
    /** Says what data class this is, because it has no row to take one from. */
    classification: federationClassificationSchema,
  }),
]);
export type PublishItemBody = z.infer<typeof publishItemSchema>;

export const disposeInboundItemSchema = z.strictObject({
  disposition: z.enum(['accepted', 'rejected']),
  /** A Work Unit a person made in this tenant to take it on. Accepting never makes one by itself. */
  linked_work_unit_id: z.uuid().optional(),
  expected_version: z.int().min(1),
});
export type DisposeInboundItemBody = z.infer<typeof disposeInboundItemSchema>;
