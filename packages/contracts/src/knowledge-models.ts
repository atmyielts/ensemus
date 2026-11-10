import { z } from 'zod';
const id = z.uuid().toLowerCase();
export const modelJobBoundsSchema = z
  .strictObject({
    maxCalls: z.int().min(1).max(1000),
    maxInputTokens: z.int().min(1).max(2147483647),
    maxOutputTokens: z.int().min(1).max(2147483647),
    maxTotalTokens: z.int().min(1),
    maxCostMicros: z.int().min(0),
    timeoutSeconds: z.int().min(1).max(86400),
  })
  .refine(
    (value) =>
      value.maxInputTokens <= value.maxTotalTokens && value.maxOutputTokens <= value.maxTotalTokens,
  );
export const requestModelQualificationSchema = z
  .strictObject({
    profileId: id,
    expectedProfileVersion: z.int().min(1),
    purpose: z.enum(['embed', 'rerank', 'answer']),
    dimension: z.int().min(1).max(8192).nullable(),
    vectorSpaceVersion: z.string().trim().min(1).max(256).nullable(),
    requestKey: id,
    bounds: modelJobBoundsSchema,
  })
  .refine((value) =>
    value.purpose === 'embed'
      ? value.dimension !== null && value.vectorSpaceVersion !== null
      : value.dimension === null && value.vectorSpaceVersion === null,
  )
  .refine((value) => value.bounds.maxCalls === 1);
export type RequestModelQualification = z.infer<typeof requestModelQualificationSchema>;
export const approveModelWorkloadSchema = z
  .strictObject({
    kind: z.enum(['document_embed', 'query', 'answer', 'agent_context']),
    scope: z.enum(['organization', 'source', 'connection']),
    sourceId: id.nullable(),
    connectionId: id.nullable(),
    purposes: z
      .array(z.enum(['embed', 'rerank', 'answer']))
      .min(1)
      .max(3),
    qualificationIds: z.array(id).min(1).max(12),
    maxClassification: z.enum(['public', 'internal', 'confidential', 'restricted']),
    bounds: modelJobBoundsSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    requestKey: id,
  })
  .refine((value) =>
    value.kind === 'document_embed'
      ? (value.scope === 'source' && value.sourceId !== null && value.connectionId === null) ||
        (value.scope === 'connection' && value.sourceId === null && value.connectionId !== null)
      : value.scope === 'organization' && value.sourceId === null && value.connectionId === null,
  );
export type ApproveModelWorkload = z.infer<typeof approveModelWorkloadSchema>;
export const requestKnowledgeModelJobSchema = z
  .strictObject({
    kind: z.enum(['query', 'answer']),
    approvalId: id,
    requestKey: id,
    bounds: modelJobBoundsSchema,
    classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
    query: z.string().trim().min(1).max(2000),
    answerId: id.nullable(),
  })
  .refine((value) => (value.kind === 'answer') === (value.answerId !== null));
export type RequestKnowledgeModelJob = z.infer<typeof requestKnowledgeModelJobSchema>;
export const modelJobBoundsBodySchema = z
  .strictObject({
    max_calls: z.int().min(1).max(1000),
    max_input_tokens: z.int().min(1).max(2147483647),
    max_output_tokens: z.int().min(1).max(2147483647),
    max_total_tokens: z.int().min(1),
    max_cost_micros: z.int().min(0),
    timeout_seconds: z.int().min(1).max(86400),
  })
  .refine(
    (value) =>
      value.max_input_tokens <= value.max_total_tokens &&
      value.max_output_tokens <= value.max_total_tokens,
  )
  .transform((value) => ({
    maxCalls: value.max_calls,
    maxInputTokens: value.max_input_tokens,
    maxOutputTokens: value.max_output_tokens,
    maxTotalTokens: value.max_total_tokens,
    maxCostMicros: value.max_cost_micros,
    timeoutSeconds: value.timeout_seconds,
  }));
export const answerModelRequestBodySchema = z
  .strictObject({ approval_id: z.uuid().toLowerCase(), bounds: modelJobBoundsBodySchema })
  .transform((value) => ({ approvalId: value.approval_id, bounds: value.bounds }));
export const requestSemanticQuerySchema = z
  .strictObject({
    approval_id: requestKnowledgeModelJobSchema.shape.approvalId,
    request_key: requestKnowledgeModelJobSchema.shape.requestKey,
    bounds: modelJobBoundsBodySchema,
    classification: requestKnowledgeModelJobSchema.shape.classification,
    query: requestKnowledgeModelJobSchema.shape.query,
  })
  .transform((value) => ({
    approvalId: value.approval_id,
    requestKey: value.request_key,
    bounds: value.bounds,
    classification: value.classification,
    query: value.query,
  }));

/** HTTP accepts bounded metadata only. Native identity and the qualification protocol are never
 * browser-supplied authority. The exact capability protocol is derived by the request service. */
export const requestModelQualificationBodySchema = z
  .strictObject({
    expected_profile_version: z.int().min(1),
    purpose: requestModelQualificationSchema.shape.purpose,
    dimension: requestModelQualificationSchema.shape.dimension,
    vector_space_version: requestModelQualificationSchema.shape.vectorSpaceVersion,
    request_key: id,
    bounds: modelJobBoundsBodySchema,
  })
  .transform((v) => ({
    expectedProfileVersion: v.expected_profile_version,
    purpose: v.purpose,
    dimension: v.dimension,
    vectorSpaceVersion: v.vector_space_version,
    requestKey: v.request_key,
    bounds: v.bounds,
  }))
  .refine(
    (v) =>
      v.bounds.maxCalls === 1 &&
      (v.purpose === 'embed'
        ? v.dimension !== null && v.vectorSpaceVersion !== null
        : v.dimension === null && v.vectorSpaceVersion === null),
  );
export const approveModelWorkloadBodySchema = z
  .strictObject({
    kind: approveModelWorkloadSchema.shape.kind,
    scope: approveModelWorkloadSchema.shape.scope,
    source_id: id.nullable(),
    connection_id: id.nullable(),
    purposes: approveModelWorkloadSchema.shape.purposes,
    qualification_ids: approveModelWorkloadSchema.shape.qualificationIds,
    max_classification: approveModelWorkloadSchema.shape.maxClassification,
    bounds: modelJobBoundsBodySchema,
    expires_at: approveModelWorkloadSchema.shape.expiresAt,
    request_key: id,
  })
  .transform((v) => ({
    kind: v.kind,
    scope: v.scope,
    sourceId: v.source_id,
    connectionId: v.connection_id,
    purposes: v.purposes,
    qualificationIds: v.qualification_ids,
    maxClassification: v.max_classification,
    bounds: v.bounds,
    expiresAt: v.expires_at,
    requestKey: v.request_key,
  }))
  .pipe(approveModelWorkloadSchema);
