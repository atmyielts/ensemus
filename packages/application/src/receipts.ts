// Owned by the receipts slice (CONNECT-06). See docs/06-delivery/m3-slices.md and ADR-027 D6. Reading is
// filtered by who can read the Work Unit, and someone who cannot gets not found.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  ExternalActionStatus,
  ReceiptBasis,
  ReceiptOutcome,
  Resolution,
} from '@ensemus/domain/external-action';

export type ExternalActionSummary = {
  id: string;
  workUnitId: string;
  workTitle: string;
  toolName: string;
  status: ExternalActionStatus;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ExternalActionReceiptView = {
  outcome: ReceiptOutcome;
  basis: ReceiptBasis;
  code: string | null;
  providerStatus: number | null;
  externalId: string | null;
  actorName: string | null;
  recordedAt: Date;
};

export type ExternalActionDetail = ExternalActionSummary & {
  connectionName: string;
  /** The exact payload, for people who can read the work. */
  payload: unknown;
  requestHash: string;
  approvalId: string | null;
  externalId: string | null;
  supersedesId: string | null;
  retryOfId: string | null;
  attemptCount: number;
  receipts: readonly ExternalActionReceiptView[];
  resolution: Resolution | null;
  resolutionReason: string | null;
  resolvedByName: string | null;
  /** Whether this person may say what happened. Worked out here, so a page cannot get it wrong. */
  canResolve: boolean;
  /** Whether this person may ask for it again. */
  canRetry: boolean;
};

export type ExternalActionPage = {
  items: readonly ExternalActionSummary[];
  next: string | null;
};

export function listExternalActions(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { workUnitId?: string; status?: ExternalActionStatus; after?: string; limit?: number },
): Promise<ExternalActionPage> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getExternalActionDetail(
  _database: AppDatabase,
  _context: TenantContext,
  _externalActionId: string,
): Promise<ExternalActionDetail> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Everything unknown this person may resolve, oldest first. */
export function listExternalActionsNeedingReview(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ExternalActionSummary[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * A person says what happened. Only from `unknown`, and only by someone who canManageWork, which leaves
 * out a service. Writes a person's receipt, an audit row and external_action.resolved. Saying it was not
 * sent ends it as failed: doing it again is retryExternalAction, with a new approval.
 */
export function resolveUnknownExternalAction(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    externalActionId: string;
    expectedVersion: number;
    resolution: Resolution;
    reason: string;
  },
): Promise<{ status: 'sent' | 'failed'; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}
