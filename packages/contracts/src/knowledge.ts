// Runtime contracts for company knowledge (ADR-029). The request and response shapes match
// docs/specifications/openapi.yaml, and a test keeps their enums the same.
import { z } from 'zod';

const classificationSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);

const uuidList = (max: number) => z.array(z.uuid()).max(max);

export const sourceGrantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('membership'), membership_id: z.uuid() }),
  z.strictObject({ kind: z.literal('team'), team_id: z.uuid() }),
  z.strictObject({ kind: z.literal('organization') }),
]);
export type SourceGrantBody = z.infer<typeof sourceGrantSchema>;

/**
 * The metadata part of an upload. The bytes come as multipart, and the service checks the size and the
 * format from them, since a browser's label for a file is only a claim.
 */
export const addSourceSchema = z.strictObject({
  title: z.string().trim().min(1).max(512),
  classification: classificationSchema,
  grants: z.array(sourceGrantSchema).max(100),
});
export type AddSourceBody = z.infer<typeof addSourceSchema>;

export const setSourceGrantsSchema = z.strictObject({
  add: z.array(sourceGrantSchema).max(100),
  remove_grant_ids: uuidList(100),
});
export type SetSourceGrantsBody = z.infer<typeof setSourceGrantsSchema>;

export const raiseClassificationSchema = z.strictObject({ classification: classificationSchema });
export type RaiseClassificationBody = z.infer<typeof raiseClassificationSchema>;

export const closeSourceSchema = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
export type CloseSourceBody = z.infer<typeof closeSourceSchema>;

export const knowledgeSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(4000),
  limit: z.int().min(1).max(50).optional(),
  allowed_source_ids: uuidList(200).optional(),
});
export type KnowledgeSearchBody = z.infer<typeof knowledgeSearchSchema>;

export const companySearchKindSchema = z.enum([
  'work_unit',
  'client',
  'project',
  'person',
  'team',
  'document',
]);
export const companySearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  kinds: z.array(companySearchKindSchema).max(6).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const askQuestionSchema = z.strictObject({ question: z.string().trim().min(1).max(4000) });
export type AskQuestionBody = z.infer<typeof askQuestionSchema>;

const subjectRef = z
  .string()
  .regex(/^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f-]{36}$/);

export const proposeFactSchema = z.strictObject({
  subject_ref: subjectRef,
  predicate: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
  claim: z.json(),
  evidence: z
    .array(
      z.strictObject({
        chunk_id: z.uuid(),
        quote_start: z.int().min(0),
        quote_end: z.int().min(1),
      }),
    )
    .min(1)
    .max(20),
  valid_from: z.iso.datetime().optional(),
  valid_until: z.iso.datetime().optional(),
});
export type ProposeFactBody = z.infer<typeof proposeFactSchema>;

export const reviewFactSchema = z.strictObject({
  decision: z.enum(['verify', 'reject']),
  reason: z.string().trim().min(1).max(2000),
});
export type ReviewFactBody = z.infer<typeof reviewFactSchema>;

const graphNode = z.strictObject({
  type: z.enum(['client', 'project', 'membership', 'team', 'work_unit', 'knowledge_source']),
  id: z.uuid(),
});

export const linkNodesSchema = z.strictObject({
  from: graphNode,
  relation: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  to: graphNode,
});
export type LinkNodesBody = z.infer<typeof linkNodesSchema>;

export const traverseGraphSchema = z.strictObject({
  from: graphNode,
  relations: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
    .max(20)
    .optional(),
  depth: z.int().min(1).max(3).optional(),
  limit: z.int().min(1).max(200).optional(),
});
export type TraverseGraphBody = z.infer<typeof traverseGraphSchema>;

export const egressProposalSchema = z.strictObject({
  destination: z.enum([
    'ensemus_cloud_managed_model',
    'customer_byom_public_api',
    'customer_private_inference',
  ]),
  destination_host: z.string().regex(/^[a-z0-9.-]{1,253}$/),
  billing_owner: z.enum(['customer', 'ensemus']),
  retention_basis: z.enum(['unreviewed', 'contract_recorded', 'self_hosted']),
  region: z.string().max(64).nullable(),
  contract_ref: z.string().max(128).nullable(),
  allowed_classes: z.array(classificationSchema).max(4),
  purposes: z
    .array(z.enum(['embed', 'rerank', 'answer']))
    .min(1)
    .max(3),
});
export type EgressProposalBody = z.infer<typeof egressProposalSchema>;

export const reviewMcpToolSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('approve'),
    side_effect_level: z.enum(['read_only', 'external_write']),
    allowed_classes: z.array(z.enum(['public', 'internal', 'confidential'])).max(3),
  }),
  z.strictObject({ decision: z.literal('reject') }),
]);
export type ReviewMcpToolBody = z.infer<typeof reviewMcpToolSchema>;

export const decideArtifactSchema = z.strictObject({
  artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: z.enum(['accepted', 'rejected']),
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type DecideArtifactBody = z.infer<typeof decideArtifactSchema>;

export const startClientOnboardingSchema = z.strictObject({
  deal_ref: z.string().trim().min(1).max(128),
  client_name: z.string().trim().min(1).max(200),
  project_name: z.string().trim().min(1).max(200),
  owner_membership_id: z.uuid(),
  reviewer_membership_id: z.uuid(),
  email_connection_id: z.uuid(),
  contact_email: z.email().max(254),
});
export type StartClientOnboardingBody = z.infer<typeof startClientOnboardingSchema>;

/** Settings for Google Workspace and Microsoft 365. Neither can name a host. */
export const driveConnectorConfigSchema = z.strictObject({
  // These go in a path. All dots would be a way out of it, even percent-encoded around them.
  drive_ids: z.array(z.string().regex(/^(?!\.+$)[A-Za-z0-9_!.-]{1,256}$/)).max(50),
});
export type DriveConnectorConfig = z.infer<typeof driveConnectorConfigSchema>;

/** An MCP connection. The server is the operator's one target, and this is only a path on it. */
export const mcpConnectorConfigSchema = z.strictObject({
  // Not `//`, which a URL parser reads as a host, and no `..`, which climbs out of the path.
  endpoint_path: z.string().regex(/^\/(?!\/)(?!.*\.\.)[A-Za-z0-9/_.-]{0,255}$/),
});
export type McpConnectorConfig = z.infer<typeof mcpConnectorConfigSchema>;

/** What a sealed OAuth credential holds, inside a lease only. Never crosses a process in the clear. */
export const oauthCredentialSchema = z.strictObject({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).max(2048),
  refresh_token: z.string().min(1).max(4096),
  /** Microsoft's directory, or absent for Google. Goes in a path, so it is held to this shape. */
  tenant: z
    .string()
    .regex(/^(?!\.+$)[A-Za-z0-9.-]{1,128}$/)
    .optional(),
});
export type OauthCredential = z.infer<typeof oauthCredentialSchema>;
