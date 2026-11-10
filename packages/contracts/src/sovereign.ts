// Runtime contracts for licensing and the organization archive (ADR-030). The request and response shapes
// match docs/specifications/openapi.yaml, and a test keeps their enums the same.
import { z } from 'zod';

/** The largest signed document an owner can paste or upload. The verifier has its own, same limit. */
export const MAX_SIGNED_DOCUMENT_BYTES = 1024 * 1024;

export const installSignedDocumentSchema = z.strictObject({
  /** The file as issued. It is checked as text, so nothing here reformats it. */
  envelope: z.string().min(1).max(MAX_SIGNED_DOCUMENT_BYTES),
});
export type InstallSignedDocumentBody = z.infer<typeof installSignedDocumentSchema>;

export const signedDocumentTypeSchema = z.enum([
  'license',
  'maintenance',
  'advisory',
  'support_policy',
]);
export type SignedDocumentTypeDto = z.infer<typeof signedDocumentTypeSchema>;

export const licenseStandingSchema = z.enum(['licensed', 'unlicensed', 'unverifiable']);
export const supportStatusSchema = z.enum(['no_agreement', 'not_started', 'active', 'lapsed']);

export const exportStatusSchema = z.enum(['requested', 'running', 'ready', 'failed', 'expired']);
export const importStatusSchema = z.enum([
  'requested',
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
]);

/**
 * Asking for an archive. The recipient's public key is required, because an archive is never written in the
 * clear, and the private key stays with whoever made the pair. There is no scope to choose yet (ADR-030 D10).
 */
export const requestExportSchema = z.strictObject({
  recipient_public_key: z.base64().min(1).max(512),
});
export type RequestExportBody = z.infer<typeof requestExportSchema>;

/** Asking to bring an archive into this organization. Nothing is uploaded here: ADR-030 D8. */
export const requestImportSchema = z.strictObject({});
export type RequestImportBody = z.infer<typeof requestImportSchema>;

export const linkImportedPersonSchema = z.strictObject({
  membership_id: z.uuid(),
});
export type LinkImportedPersonBody = z.infer<typeof linkImportedPersonSchema>;
