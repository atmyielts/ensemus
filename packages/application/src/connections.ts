// Owned by the sdk slice (CONNECT-01). See docs/06-delivery/m3-slices.md and ADR-027 D3. Managing a
// connection needs connection.manage. A credential arrives here already sealed, as a reference.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ConnectionState, SyncPage } from '@ensemus/domain/connector';
import type { SyncStreamLease } from './integration-ports';

export type ConnectionView = {
  id: string;
  connectorType: string;
  displayName: string;
  state: ConnectionState;
  /** Whether a credential is on file. The credential itself is never read here. */
  hasCredential: boolean;
  lastErrorCode: string | null;
  version: number;
  createdAt: Date;
};

export function createConnection(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    connectorType: string;
    displayName: string;
    /** Already checked against the connector's settings by the caller. */
    config: unknown;
    credentialSecretId: string | null;
  },
): Promise<ConnectionView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listConnections(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ConnectionView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getConnection(
  _database: AppDatabase,
  _context: TenantContext,
  _connectionId: string,
): Promise<ConnectionView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Takes effect at once for anything not already past its attempt, because the recheck before each send
 * reads this row. Emits connection.revoked, and the connector worker then revokes the sealed secret.
 */
export function revokeConnection(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function requestConnectorSync(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What the connector worker does with a connection it was told about. Read under the tenant. */
export function loadConnectionForWorker(
  _database: AppDatabase,
  _context: TenantContext,
  _connectionId: string,
): Promise<{
  id: string;
  connectorType: string;
  state: ConnectionState;
  config: unknown;
  credentialSecretId: string | null;
} | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Takes one stream's lease, creating the row if this is its first pass. Null if someone holds it. */
export function leaseSyncStream(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string; stream: string; leaseMs: number },
): Promise<SyncStreamLease | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export type MappedSyncPage = SyncPage & {
  /** Each resource's grants with who they mapped to, by the resource's position in the page. */
  mappedGrants: ReadonlyArray<
    ReadonlyArray<{
      principalKind: string;
      principalExternalId: string;
      access: string;
      membershipId: string | null;
      teamId: string | null;
    }>
  >;
};

/**
 * Commits a page: resources, their grants, deletions and the cursor, in one transaction, if the
 * generation still matches. A resource already at this version is left alone, which is what makes a
 * repeat of a page do nothing. Returns the new state, or null if the generation had moved.
 */
export function commitSyncPage(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string; lease: SyncStreamLease; page: MappedSyncPage },
): Promise<SyncStreamLease | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export function finishSyncStream(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    connectionId: string;
    stream: string;
    outcome: { ok: true } | { ok: false; code: string } | { resyncRequired: true };
  },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The default directory: an email address finds a membership, and everything else finds nobody. */
export function resolveSourcePrincipal(
  _database: AppDatabase,
  _context: TenantContext,
  _principal: { kind: 'user' | 'group' | 'domain' | 'anyone'; externalId: string },
): Promise<{ membershipId: string } | { teamId: string } | null> {
  throw new Error('NOT_IMPLEMENTED');
}
