// Runtime contracts for custom objects (KNOW-07, ADR-031 D11). Limits that need the whole shape are checked by
// validateObjectSchema in the domain. This only keeps out what could never be right.
import { z } from 'zod';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const label = z.string().trim().min(1).max(120);
const dataClass = z.enum(['public', 'internal', 'confidential', 'restricted']);

export const objectFieldSchema = z.strictObject({
  key,
  label,
  kind: z.enum(['text', 'long_text', 'number', 'boolean', 'date', 'enum', 'email', 'url']),
  required: z.boolean(),
  indexed: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  maxLength: z.number().int().positive().max(50_000).optional(),
});
export type ObjectFieldBody = z.infer<typeof objectFieldSchema>;

export const objectRelationSchema = z.strictObject({
  key,
  label,
  toTypeSlug: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  cardinality: z.enum(['one', 'many']),
});
export type ObjectRelationBody = z.infer<typeof objectRelationSchema>;

export const createObjectTypeSchema = z.strictObject({
  slug: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  display_name: label,
  classification: dataClass,
  fields: z.array(objectFieldSchema).max(64),
  relations: z.array(objectRelationSchema).max(16),
});
export type CreateObjectTypeBody = z.infer<typeof createObjectTypeSchema>;

export const addObjectTypeVersionSchema = z.strictObject({
  fields: z.array(objectFieldSchema).max(64),
  relations: z.array(objectRelationSchema).max(16),
});
export type AddObjectTypeVersionBody = z.infer<typeof addObjectTypeVersionSchema>;

const attributes = z.record(key, z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const createObjectRecordSchema = z.strictObject({
  display_name: label,
  attributes,
  classification: dataClass.optional(),
});
export type CreateObjectRecordBody = z.infer<typeof createObjectRecordSchema>;

export const updateObjectRecordSchema = z.strictObject({
  display_name: label.optional(),
  attributes: attributes.optional(),
  classification: dataClass.optional(),
});
export type UpdateObjectRecordBody = z.infer<typeof updateObjectRecordSchema>;

export const linkObjectRecordsSchema = z.strictObject({
  relation_key: key,
  to_record_id: z.uuid(),
});
export type LinkObjectRecordsBody = z.infer<typeof linkObjectRecordsSchema>;
