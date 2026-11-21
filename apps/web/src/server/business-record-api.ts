import 'server-only';
import { idSchema, type BusinessRecordView } from '@ensemus/application';
import { z } from 'zod';
export const businessRecordParams = z.object({ organizationId: idSchema, recordId: idSchema });
export const businessRecordQuery = z.strictObject({
  connection_id: idSchema.optional(),
  stream: z
    .string()
    .regex(/^[a-z0-9_.-]{1,64}$/)
    .optional(),
  cursor: z.string().min(1).max(512).optional(),
});
export function businessRecordDto(row: BusinessRecordView) {
  return {
    id: row.id,
    connection_id: row.connectionId,
    stream: row.stream,
    external_id: row.externalId,
    external_version: row.externalVersion,
    display_name: row.displayName,
    classification: row.classification,
    fields: row.fields,
    updated_at: row.updatedAt.toISOString(),
  };
}
