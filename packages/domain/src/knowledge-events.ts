// Outbox event names for company knowledge (ADR-029). Payloads are IDs and enums only, and the dispatcher
// sees none of them: it works from the event's type and aggregate ID alone.

export const AGGREGATE_KNOWLEDGE_DOCUMENT = 'knowledge_document';
/** Also the ledger's target type: a tombstone's event has this aggregate (ADR-026, ADR-029 D3). */
export const AGGREGATE_KNOWLEDGE_SOURCE = 'knowledge_source';
export const AGGREGATE_KNOWLEDGE_ANSWER = 'knowledge_answer';
export const AGGREGATE_CLIENT_ONBOARDING = 'client_onboarding';

/** A document's bytes are stored or staged. The dispatcher starts knowledgeIngestWorkflow. */
export const KNOWLEDGE_DOCUMENT_RECEIVED = 'knowledge.document_received';
/** Facts for projections and the timeline. Nothing outside PostgreSQL consumes these yet. */
export const KNOWLEDGE_DOCUMENT_SEARCHABLE = 'knowledge.document_searchable';
export const KNOWLEDGE_DOCUMENT_REJECTED = 'knowledge.document_rejected';

/**
 * A source was revoked or deleted. Serving stopped in the transaction that wrote this, and the dispatcher
 * starts knowledgePurgeWorkflow to remove what was derived from it. The tombstone has its own event.
 */
export const KNOWLEDGE_SOURCE_CLOSED = 'knowledge.source_closed';
/** Gate D's "report completion". The purge job's row holds the counts. */
export const KNOWLEDGE_PURGE_COMPLETED = 'knowledge.purge_completed';

/** A current native typed-record closure asks for fresh material cleanup, not historical reads. */
export const KNOWLEDGE_RECORD_PURGE_REQUESTED = 'knowledge.record_purge_requested';

/** Someone asked a question. The dispatcher starts knowledgeAnswerWorkflow. */
export const KNOWLEDGE_ANSWER_REQUESTED = 'knowledge.answer_requested';
export const KNOWLEDGE_ANSWER_FINISHED = 'knowledge.answer_finished';

export const KNOWLEDGE_FACT_PROPOSED = 'knowledge.fact_proposed';
export const KNOWLEDGE_FACT_REVIEWED = 'knowledge.fact_reviewed';

/** Another server's tools changed or were reviewed. No workflow needs these. */
export const MCP_TOOL_REVIEWED = 'mcp.tool_reviewed';

/** A deal was won. The dispatcher starts clientOnboardingWorkflow. */
export const CLIENT_ONBOARDING_REQUESTED = 'client_onboarding.requested';

/** Notification kinds. The target is `knowledge_answer:{id}`, or `knowledge_fact:{id}`. */
export const NOTIFY_KNOWLEDGE_ANSWER_READY = 'knowledge.answer_ready';
export const NOTIFY_KNOWLEDGE_FACT_DISPUTED = 'knowledge.fact_disputed';
export const knowledgeAnswerTargetRef = (id: string) => `knowledge_answer:${id}`;
export const knowledgeFactTargetRef = (id: string) => `knowledge_fact:${id}`;
export const knowledgeSourceTargetRef = (id: string) => `knowledge_source:${id}`;
