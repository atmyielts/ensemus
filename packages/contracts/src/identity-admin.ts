// Runtime contracts for MFA policy and SSO administration (ADR-031 D8, D9). No shape here can name a host the
// server would connect to, which is why a provider is described by its metadata and nothing else.
import { z } from 'zod';

export const updateSecurityPolicySchema = z.strictObject({
  mfa_for_administration: z.boolean(),
  mfa_max_age_seconds: z.number().int().min(60).max(3600),
  sso_enforcement: z.enum(['optional', 'required']),
});
export type UpdateSecurityPolicyBody = z.infer<typeof updateSecurityPolicySchema>;

export const stepUpSchema = z.strictObject({
  code: z.string().regex(/^[0-9A-Za-z-]{6,32}$/),
  kind: z.enum(['totp', 'backup_code']),
});
export type StepUpBody = z.infer<typeof stepUpSchema>;

const domain = z
  .string()
  .max(253)
  .regex(/^(?=.*\.)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

export const createSsoConnectionSchema = z.strictObject({
  display_name: z.string().trim().min(1).max(120),
  domain,
  /** The provider's SAML metadata. Bounded, and parsed only by the SSO slice's checked parser. */
  idp_metadata_xml: z.string().min(1).max(200_000),
});
export type CreateSsoConnectionBody = z.infer<typeof createSsoConnectionSchema>;

export const updateSsoConnectionSchema = z.strictObject({
  display_name: z.string().trim().min(1).max(120).optional(),
  state: z.enum(['active', 'disabled']).optional(),
  auto_join: z.boolean().optional(),
});
export type UpdateSsoConnectionBody = z.infer<typeof updateSsoConnectionSchema>;
