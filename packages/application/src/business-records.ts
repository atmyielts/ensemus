// Owned by the business-records slice (EXP-02). See docs/06-delivery/m11a-slices.md and ADR-033 D3. Stored
// fields from a connector, read through the source's own permissions, and the effects proposed on them, which
// go through the verified external action path (ADR-027) like anything else that leaves.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type {
  BusinessConnectorType,
  RecordFields,
} from '@ensemus/domain/business-connector';

export type BusinessRecordPage = {
  connectionId: string;
  connectorType: BusinessConnectorType;
  stream: string;
  records: readonly {
    externalId: string;
    externalVersion: string | null;
    displayName: string | null;
    fields: RecordFields;
    fieldsSha256: string;
    classification: 'public' | 'internal' | 'confidential' | 'restricted';
  }[];
  deletedExternalIds: readonly string[];
};

export type BusinessRecordView = {
  id: string;
  connectionId: string;
  stream: string;
  externalId: string;
  externalVersion: string | null;
  displayName: string | null;
  classification: string;
  fields: RecordFields;
  updatedAt: Date;
};

export type BusinessRecordList = { items: readonly BusinessRecordView[]; nextCursor: string | null };

export type ProposedBusinessAction = {
  externalActionId: string;
  approvalId: string;
  requestHash: string;
};

/**
 * Stores one page's kept fields, for the connector worker's sink. Idempotent on (connection, external ID,
 * fields hash), so a repeated page touches nothing, `updated_at` included. Refuses a non-service context, and a
 * connection whose type is not `connectorType`.
 */
export function applyBusinessRecordPage(
  _database: AppDatabase,
  _context: TenantContext,
  _page: BusinessRecordPage,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Only records this person has a source grant for, from active connections. Others do not appear. */
export function listBusinessRecords(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId?: string; stream?: string; after?: string; limit?: number },
): Promise<BusinessRecordList> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Not found unless canReadBusinessRecord says yes, so a record nobody granted looks like no record. */
export function getBusinessRecord(
  _database: AppDatabase,
  _context: TenantContext,
  _recordId: string,
): Promise<BusinessRecordView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Writes an intent and its approval in the caller's transaction, as proposeExternalActionInTx does for email.
 * That one takes email only, so this is its twin for BUSINESS_TOOLS, and the triggers in migration 0013 hold
 * them to the same rules. Refuses restricted work and a connection without the write scope.
 */
export function proposeBusinessActionInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: {
    workUnitId: string;
    connectionId: string;
    toolName: string;
    toolVersion: string;
    payload: unknown;
    approverMembershipId: string;
    expiresAt?: Date;
    supersedesId?: string;
    retryOfId?: string;
    businessRecordId?: string;
  },
): Promise<ProposedBusinessAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Proposes changing writable fields on a record this person can read. `expectedVersion` must match what is
 * stored, or RECORD_VERSION_STALE, so nobody asks for approval on something they did not see.
 */
export function proposeRecordUpdate(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    recordId: string;
    workUnitId: string;
    expectedVersion: string | null;
    changes: Readonly<Record<string, string | number | boolean | null>>;
    approverMembershipId: string;
  },
): Promise<ProposedBusinessAction> {
  throw new Error('NOT_IMPLEMENTED');
}

export function proposeTicketComment(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { recordId: string; workUnitId: string; body: string; approverMembershipId: string },
): Promise<ProposedBusinessAction> {
  throw new Error('NOT_IMPLEMENTED');
}

export function proposeInvoiceDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    workUnitId: string;
    connectionId: string;
    invoice: unknown;
    approverMembershipId: string;
  },
): Promise<ProposedBusinessAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/** QA-007 for these tools: a new intent and a new approval, and the old one can never be spent. */
export function reviseBusinessAction(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    externalActionId: string;
    expectedVersion: number;
    payload: unknown;
    approverMembershipId: string;
  },
): Promise<ProposedBusinessAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/** A new intent for a failed one, with `retry_of_id`, needing its own approval. */
export function retryBusinessAction(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { externalActionId: string; approverMembershipId: string },
): Promise<ProposedBusinessAction> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Clears stored fields for connections that were revoked. Called from a tenant's upkeep. */
export async function purgeRevokedBusinessRecords(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<number> {
  return 0;
}
