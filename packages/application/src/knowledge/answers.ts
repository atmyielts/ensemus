// Owned by the compile slice (UX-18's service). See docs/06-delivery/m5-slices.md and ADR-029 D5. The web
// tier has no model path, so asking writes a row and an event, and a worker does the rest under the
// asker's own membership. A read rechecks every source through row-level security.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { AnswerState, KnowledgeCode } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import type { CompileDeps } from './compiler';

export type AnswerCitationView = {
  ordinal: number;
  answerStart: number;
  answerEnd: number;
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  excerpt: string;
  sourceVersion: string | null;
  sourceUrl: string | null;
  sourceModifiedAt: Date | null;
  /** `current`, or `superseded` when a newer version of the source has arrived since. */
  freshness: 'current' | 'superseded';
};

export type AnswerView = {
  id: string;
  state: AnswerState;
  question: string;
  answerText: string | null;
  refusalCode: KnowledgeCode | null;
  citations: readonly AnswerCitationView[];
  strongestClassification: Classification | null;
  /** Micro-USD. Shown as an estimate. Null when the model's profile has no rate card. */
  costMicros: number | null;
  version: number;
  createdAt: Date;
  finishedAt: Date | null;
};

/** Refuses a service context. Writes the row and `knowledge.answer_requested` in one transaction. */
export function askQuestion(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { question: string; requestKey?: string },
): Promise<{ answerId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Row-level security hides an answer from anyone but its asker, and from them once any source that went
 * in is out of their reach, so this answers NOT_FOUND then, with no sign of why.
 */
export function getAnswer(
  _database: AppDatabase,
  _context: TenantContext,
  _answerId: string,
): Promise<AnswerView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listMyAnswers(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { after?: string; limit?: number },
): Promise<{ items: readonly AnswerView[]; next: string | null }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type AnswerStep = {
  outcome: 'answered' | 'no_evidence' | 'refused' | 'failed' | 'already_done';
  code: KnowledgeCode | null;
};

/**
 * The worker's half. `service` reads and writes the row. `asker` is the asker's delegated context
 * (`createDelegatedContext`), and all retrieval uses that, so a person who lost access mid-question gets
 * no evidence. No evidence means no model call and `no_evidence`, and an answer failing the citation check
 * is stored as `refused`, with its text discarded. Safe to run again.
 */
export function runAnswer(
  _database: AppDatabase,
  _contexts: { service: TenantContext; asker: TenantContext },
  _deps: CompileDeps,
  _input: { answerId: string; signal: AbortSignal },
): Promise<AnswerStep> {
  throw new Error('NOT_IMPLEMENTED');
}
