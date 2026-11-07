// Runtime contracts for packs (AGENT-14, ADR-031 D10). There is no accept-all shape on purpose: each capability
// is decided on its own, by name.
import { z } from 'zod';

export const requestPackInstallSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type RequestPackInstallBody = z.infer<typeof requestPackInstallSchema>;

export const decidePackCapabilitySchema = z.strictObject({
  capability_key: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
  decision: z.enum(['accepted', 'declined']),
});
export type DecidePackCapabilityBody = z.infer<typeof decidePackCapabilitySchema>;
