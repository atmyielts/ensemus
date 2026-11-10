import { z } from 'zod';

export const classifications = ['public', 'internal', 'confidential', 'restricted'] as const;
export const classificationSchema = z.enum(classifications);
export type Classification = z.infer<typeof classificationSchema>;

/** Runtime contract for docs/specifications/schemas/domain-event.schema.json (version 1). */
export const domainEventSchema = z.strictObject({
  event_id: z.uuid(),
  event_type: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  schema_version: z.int().min(1),
  organization_id: z.uuid(),
  aggregate_type: z.string().min(1),
  aggregate_id: z.uuid(),
  aggregate_version: z.int().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  actor: z.strictObject({
    kind: z.enum(['membership', 'service', 'agent', 'system']),
    id: z.string(),
  }),
  classification: classificationSchema,
  correlation_id: z.uuid(),
  causation_id: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof domainEventSchema>;

/** The public API error shape. Messages are safe and fixed; details never echo input. */
export const apiErrorSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string(),
  request_id: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const organizationNameSchema = z.string().trim().min(1).max(120);
