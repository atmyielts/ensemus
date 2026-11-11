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

/**
 * A malware check of a document's original bytes (ADR-029 D4 addendum). `not_scanned` is honest: no
 * scanner was configured, and nothing claims one ran. `infected` is final: the bytes are quarantined,
 * never parsed and never searchable. `scan_failed` means a scanner was asked and could not answer.
 */
export const SCAN_STATES = ['not_scanned', 'clean', 'infected', 'scan_failed'] as const;
export type ScanState = (typeof SCAN_STATES)[number];

/** The same moves migration 0710's trigger allows. Nothing returns to `not_scanned` or leaves `infected`. */
export const SCAN_TRANSITIONS: Readonly<Record<ScanState, readonly ScanState[]>> = {
  not_scanned: ['not_scanned', 'clean', 'infected', 'scan_failed'],
  scan_failed: ['clean', 'infected', 'scan_failed'],
  clean: ['clean', 'infected', 'scan_failed'],
  infected: ['infected'],
};

export const scanTransitionAllowed = (from: ScanState, to: ScanState) =>
  SCAN_TRANSITIONS[from].includes(to);

/**
 * Whether a document must be scanned clean before it is indexed. `required` is the default whenever a
 * scanner is configured; `optional` indexes what the scanner could not check, and says so.
 */
export const SCAN_POLICIES = ['required', 'optional'] as const;
export type ScanPolicy = (typeof SCAN_POLICIES)[number];

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
  /** A PDF that needs a password, or whose author forbade copying its text. Never guessed at. */
  'ENCRYPTED_DOCUMENT',
  /** A PDF with pages and no text layer, such as a scan. Nothing is invented for it. */
  'NEEDS_OCR',
  /** A container that is not what it claims, or breaks a safety limit of its structure. */
  'MALFORMED_DOCUMENT',
  /** The malware scanner found something. The bytes are quarantined and never parsed. */
  'SCAN_FLAGGED',
  /** Scanning is required and the scanner could not answer. Retried; never indexed meanwhile. */
  'SCAN_FAILED',
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

/** Formats read as text, with no container around them. */
export const TEXT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
] as const;

export const PDF_MEDIA_TYPE = 'application/pdf';
export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Every format the knowledge worker parses (ADR-029 D4 and its addendum). A format not here is refused
 * with UNSUPPORTED_FORMAT. Only text comes out: nothing is rendered, run or followed.
 */
export const INGESTIBLE_MEDIA_TYPES = [
  ...TEXT_MEDIA_TYPES,
  PDF_MEDIA_TYPE,
  DOCX_MEDIA_TYPE,
  PPTX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
] as const;
export type IngestibleMediaType = (typeof INGESTIBLE_MEDIA_TYPES)[number];

/** The extension a browser may leave unlabelled, for each format, so an upload can still be named. */
export const INGESTIBLE_EXTENSIONS: Readonly<Record<string, IngestibleMediaType>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  pdf: PDF_MEDIA_TYPE,
  docx: DOCX_MEDIA_TYPE,
  pptx: PPTX_MEDIA_TYPE,
  xlsx: XLSX_MEDIA_TYPE,
};

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

/**
 * Approximate vector search (ADR-029 D6 addendum, migration 0711). Each dimension here has a partial HNSW
 * index on `knowledge.embeddings`, cast to a fixed width. A space of another dimension is always searched
 * exactly. The index name is checked against the migration by a test.
 */
export const HNSW_INDEXED_DIMENSIONS: Readonly<
  Record<number, { type: 'vector' | 'halfvec'; index: string }>
> = {
  384: { type: 'vector', index: 'knowledge_embeddings_hnsw_384' },
  768: { type: 'vector', index: 'knowledge_embeddings_hnsw_768' },
  1024: { type: 'vector', index: 'knowledge_embeddings_hnsw_1024' },
  1536: { type: 'vector', index: 'knowledge_embeddings_hnsw_1536' },
  // HNSW indexes `vector` up to 2,000 dimensions; wider spaces use half precision in the index only.
  3072: { type: 'halfvec', index: 'knowledge_embeddings_hnsw_3072' },
};

/**
 * Below this many authorized vectors in a space, search is exact: perfect recall, and cheaper than an
 * index walk that would have to skip most of a shared graph to find a small tenant's rows.
 */
export const EXACT_VECTOR_SEARCH_MAX_ROWS = 20_000;

/** pgvector settings for a filtered HNSW walk, set per transaction. Measured by knowledge-recall. */
export const HNSW_SEARCH_SETTINGS = {
  iterativeScan: 'strict_order',
  efSearch: 200,
  maxScanTuples: 200_000,
  scanMemMultiplier: 4,
} as const;

/** The recall@10 an approximate search must reach against exact, under every measured ACL. */
export const TARGET_FILTERED_RECALL_AT_10 = 0.95;

/** Which vector search a query used. `exact` is chosen whenever approximate cannot be shown safe. */
export type VectorSearchMode = 'exact' | 'approximate';

export function vectorSearchMode(input: {
  dimension: number;
  authorizedRows: number;
}): VectorSearchMode {
  if (!Object.hasOwn(HNSW_INDEXED_DIMENSIONS, input.dimension)) return 'exact';
  return input.authorizedRows > EXACT_VECTOR_SEARCH_MAX_ROWS ? 'approximate' : 'exact';
}

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
