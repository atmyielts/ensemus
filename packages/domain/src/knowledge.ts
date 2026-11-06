// Company knowledge, as pure rules (ADR-029). The database holds the same lifecycles in triggers, because
// the web tier and the workers share a role, and a test keeps the two equal. Nothing here does any I/O.
import type { Classification } from './policy';

export const SOURCE_KINDS = ['upload', 'connector'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATES = ['active', 'revoked', 'deleted'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const GRANT_PRINCIPALS = ['membership', 'team', 'organization'] as const;
export type GrantPrincipal = (typeof GRANT_PRINCIPALS)[number];

export const DOCUMENT_STATES = [
  'received',
  'parsing',
  'searchable',
  'rejected',
  'failed',
  'purged',
] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const DOCUMENT_TRANSITIONS: Readonly<Record<DocumentState, readonly DocumentState[]>> = {
  received: ['parsing', 'rejected', 'failed', 'purged'],
  parsing: ['searchable', 'rejected', 'failed', 'purged'],
  failed: ['parsing', 'purged'],
  rejected: ['purged'],
  searchable: ['purged'],
  purged: [],
};

/** Lexical search needs none of this, so `denied` and `failed` still leave a document searchable. */
export const EMBEDDING_STATES = ['pending', 'embedding', 'embedded', 'denied', 'failed'] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

/** `not_scanned` is honest: no scanner ships yet, and nothing here claims one ran (ADR-029 D4). */
export const SCAN_STATES = ['not_scanned', 'clean', 'flagged'] as const;
export type ScanState = (typeof SCAN_STATES)[number];

export const FACT_STATES = ['proposed', 'verified', 'disputed', 'superseded', 'rejected'] as const;
export type FactState = (typeof FACT_STATES)[number];

export const FACT_TRANSITIONS: Readonly<Record<FactState, readonly FactState[]>> = {
  proposed: ['verified', 'disputed', 'rejected', 'superseded'],
  disputed: ['verified', 'rejected', 'superseded'],
  verified: ['disputed', 'superseded'],
  superseded: [],
  rejected: [],
};

export const FACT_ORIGINS = ['model', 'person'] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];

export const ANSWER_STATES = [
  'queued',
  'running',
  'answered',
  'no_evidence',
  'refused',
  'failed',
] as const;
export type AnswerState = (typeof ANSWER_STATES)[number];

export const PURGE_REASONS = [
  'deleted',
  'revoked',
  'connection_revoked',
  'resource_gone',
  'restore_reapply',
] as const;
export type PurgeReason = (typeof PURGE_REASONS)[number];

export const PURGE_STATES = ['pending', 'running', 'completed', 'failed'] as const;
export type PurgeState = (typeof PURGE_STATES)[number];

export const GRAPH_NODE_TYPES = [
  'client',
  'project',
  'membership',
  'team',
  'work_unit',
  'knowledge_source',
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];
export type GraphNode = { type: GraphNodeType; id: string };

/**
 * The links a person may add. Structure the tables already hold (a project's client, a Work Unit's
 * project) is read live in `knowledge.graph_links`, and is not here. A relation not named here is refused.
 */
export const EDGE_RULES: Readonly<
  Record<string, { from: readonly GraphNodeType[]; to: readonly GraphNodeType[] }>
> = {
  documents: { from: ['knowledge_source'], to: ['client', 'project', 'work_unit'] },
  account_lead_for: { from: ['membership'], to: ['client'] },
  responsible_for: { from: ['team'], to: ['client', 'project'] },
  related_to: { from: ['client', 'project'], to: ['client', 'project'] },
};

export function edgeAllowed(from: GraphNodeType, relation: string, to: GraphNodeType) {
  const rule = Object.hasOwn(EDGE_RULES, relation) ? EDGE_RULES[relation] : undefined;
  return rule !== undefined && rule.from.includes(from) && rule.to.includes(to);
}

/** The most hops a traversal may take. Long enough for client to project to work, and bounded. */
export const GRAPH_MAX_DEPTH = 3;
export const GRAPH_MAX_NODES = 200;

/** Stored on a document, a model call or an answer. Codes only: never a provider's or a file's words. */
export const KNOWLEDGE_CODES = [
  // Parsing.
  'UNSUPPORTED_FORMAT',
  'TOO_LARGE',
  'EMPTY_DOCUMENT',
  'UNREADABLE_ENCODING',
  'PARSE_TIMEOUT',
  'PARSE_FAILED',
  'SCAN_FLAGGED',
  // Model calls.
  'EGRESS_DENIED',
  'NO_APPROVED_MODEL',
  'MODEL_UNAVAILABLE',
  'BUDGET_EXHAUSTED',
  'SPACE_MISMATCH',
  // Answers.
  'NO_AUTHORIZED_EVIDENCE',
  'CITATION_INVALID',
  'NOT_GROUNDED',
  // Sync and purge.
  'CONNECTOR_READ_FAILED',
  'SOURCE_CLOSED',
  'STORE_UNAVAILABLE',
] as const;
export type KnowledgeCode = (typeof KNOWLEDGE_CODES)[number];

const RANK: Readonly<Record<Classification, number>> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
};

/** Mixing inherits the strongest class (01-security-blueprint section 2). */
export function strongestClass(classes: readonly Classification[]): Classification {
  let strongest: Classification = 'public';
  for (const value of classes) if (RANK[value] > RANK[strongest]) strongest = value;
  return strongest;
}

export const canRaiseClass = (from: Classification, to: Classification) => RANK[to] >= RANK[from];

/**
 * Who a grant may name for a class. `organization` is for public and internal only, and `restricted` is
 * for named people only. The database refuses the rest, and narrows existing grants if a class rises.
 */
export function grantAllowedFor(principal: GrantPrincipal, classification: Classification) {
  if (principal === 'membership') return true;
  if (principal === 'team') return classification !== 'restricted';
  return classification === 'public' || classification === 'internal';
}

/** A file's text-family formats. A format not here is refused with UNSUPPORTED_FORMAT (ADR-029 D4). */
export const INGESTIBLE_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
] as const;
export type IngestibleMediaType = (typeof INGESTIBLE_MEDIA_TYPES)[number];

export const MAX_DOCUMENT_BYTES = 26_214_400;
/** Stops a small file becoming millions of rows. Past this, a document is refused and not truncated. */
export const MAX_CHUNKS_PER_DOCUMENT = 20_000;

/** Bumped when chunk boundaries change, so a re-index knows what it has. */
export const CHUNKER_VERSION = 'v1';

/** Where a document's bytes live. Keys are IDs only, and reveal nothing. */
export const knowledgeObjectKey = (organizationId: string, documentId: string) =>
  `${organizationId}/knowledge/${documentId}`;

/** The most an answer's context may hold, whatever a caller asks for. */
export const MAX_EVIDENCE_TOKENS = 12_000;
export const MAX_QUESTION_CHARS = 4_000;
/** Candidates each of lexical and vector search gets before fusion. */
export const RETRIEVAL_CANDIDATES = 50;

/** A tool's effect, as a named admin set it. An MCP server's own annotations never set this. */
export const MCP_SIDE_EFFECTS = ['read_only', 'external_write'] as const;
export type McpSideEffect = (typeof MCP_SIDE_EFFECTS)[number];
export const MCP_TOOL_STATES = ['pending_review', 'approved', 'rejected', 'removed'] as const;
export type McpToolState = (typeof MCP_TOOL_STATES)[number];

export const ONBOARDING_STATES = [
  'started',
  'waiting_for_brief',
  'waiting_for_acceptance',
  'waiting_for_send',
  'completed',
  'failed',
  'unknown',
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];
