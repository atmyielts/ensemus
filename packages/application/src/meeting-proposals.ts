// Owned by the meetings-proposals slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D7. Derived work
// is proposed, never applied: this is the only path from a proposal to a Work Unit, and it takes a person.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ProposedItemKind, ProposedItemStatus } from '@ensemus/domain/meeting';

export type ProposedItemView = {
  id: string;
  meetingId: string;
  kind: ProposedItemKind;
  /** Null once consent has gone. */
  title: string | null;
  detail: string | null;
  suggestedOwnerMembershipId: string | null;
  suggestedDueOn: string | null;
  status: ProposedItemStatus;
  decidedByMembershipId: string | null;
  decidedAt: Date | null;
  workUnitId: string | null;
  version: number;
};

export type MeetingSummaryTextView = {
  id: string;
  runId: string;
  /** Null once consent has gone. */
  text: string | null;
  /** Always `model_generated`, and the page says so. */
  trust: 'model_generated';
  createdAt: Date;
};

/** For people canReadMeetingContent says yes to. Anyone else gets not found. */
export function listProposedItems(
  _database: AppDatabase,
  _context: TenantContext,
  _meetingId: string,
): Promise<readonly ProposedItemView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listMeetingSummaries(
  _database: AppDatabase,
  _context: TenantContext,
  _meetingId: string,
): Promise<readonly MeetingSummaryTextView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * A person turns proposed work into a Work Unit, in one transaction with the proposal's status. What lands on
 * it is what they sent, and the classification is the meeting's, so derived work is never less protected than
 * its source. A service context is refused. See the slice brief for why this writes the Work Unit itself.
 */
export function acceptProposedWork(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    itemId: string;
    expectedVersion: number;
    title: string;
    objective?: string;
    ownerMembershipId: string;
    dueAt: Date | null;
  },
): Promise<{ workUnitId: string; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** A person records a proposed decision as made. It stays with the meeting and starts no work. */
export function acceptProposedDecision(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { itemId: string; expectedVersion: number; reason?: string },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function rejectProposedItem(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { itemId: string; expectedVersion: number; reason?: string },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}
