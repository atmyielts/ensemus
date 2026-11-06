// What a connector reports, in terms the rest of the product can use (ADR-027 D3). Pure types and small
// rules. The SDK in @ensemus/connectors builds on these, and application services never see a connector.

export const SYNC_STATES = ['idle', 'running', 'failed', 'resync_required'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export const CONNECTION_STATES = ['active', 'disabled', 'revoked'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** What a sealed value is for. The broker refuses to open one for anything else. */
export const SECRET_PURPOSE_CONNECTOR_CREDENTIAL = 'connector_credential';
export const SECRET_PURPOSE_WEBHOOK_SIGNING = 'webhook_signing';

export const PRINCIPAL_KINDS = ['user', 'group', 'domain', 'anyone'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const SOURCE_ACCESS = ['read', 'write', 'owner'] as const;
export type SourceAccess = (typeof SOURCE_ACCESS)[number];

/** One grant, as the source states it. */
export type SourceGrant = {
  principalKind: PrincipalKind;
  /** The source's own name for them, such as an email address or a group ID. */
  principalExternalId: string;
  access: SourceAccess;
};

export type SyncedResource = {
  externalId: string;
  resourceType: string;
  /** The source's revision. A page holding the version already stored changes nothing. */
  externalVersion: string | null;
  displayName?: string;
  contentSha256?: string;
  classification?: 'public' | 'internal' | 'confidential' | 'restricted';
  /** Every grant the source reports. Leaving out a principal is how a revoke reaches here. */
  acl: readonly SourceGrant[];
};

/** One page. It commits whole, in one transaction, with the cursor it moves to. */
export type SyncPage = {
  resources: readonly SyncedResource[];
  /** Gone at the source, for sources that report it. A full sync finds the rest by absence. */
  deletedExternalIds: readonly string[];
  /** Where the next read starts. Opaque, and kept only in PostgreSQL. */
  nextCursor: string | null;
  hasMore: boolean;
  watermark?: Date;
};

export type AclState = 'mapped' | 'partial' | 'unmapped';

/**
 * Whether a resource's grants are all understood. Fail closed: a grant nobody could map leaves it
 * partial, and retrieval in M5 must treat anything but `mapped` as denied for what it cannot place.
 */
export function aclStateOf(grants: number, mapped: number): AclState {
  if (grants === 0 || mapped === 0) return 'unmapped';
  return mapped === grants ? 'mapped' : 'partial';
}
