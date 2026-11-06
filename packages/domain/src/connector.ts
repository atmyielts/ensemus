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
  /** What kind of thing this is at the source. Which stream found it is kept apart from this. */
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

export const CONNECTOR_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const SYNC_STREAM_PATTERN = /^[a-z0-9_.-]{1,64}$/;
const RESOURCE_TYPE_PATTERN = /^[a-z0-9_.-]{1,64}$/;

/**
 * Why a stream's last read failed, shown to an administrator. A fixed list, because a connector's own
 * text could hold a credential or anything else its provider said.
 */
export const SYNC_ERROR_CODES = [
  'SYNC_FAILED',
  'SYNC_UNAVAILABLE',
  'SYNC_TIMEOUT',
  'SYNC_NO_PROGRESS',
  'SYNC_PAGE_INVALID',
  'SYNC_RATE_LIMITED',
  'SYNC_AUTH_FAILED',
  'CONFIG_INVALID',
  'CREDENTIAL_UNAVAILABLE',
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/** Anything off the list is reported as a failure and nothing more. */
export function safeSyncErrorCode(code: unknown): SyncErrorCode {
  return (SYNC_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as SyncErrorCode)
    : 'SYNC_FAILED';
}

/** Generous for one page, and small enough that one bad connector cannot hold a transaction open. */
export const MAX_SYNC_PAGE_RESOURCES = 1000;
export const MAX_SYNC_RESOURCE_GRANTS = 1000;
const MAX_CURSOR_LENGTH = 8192;
const MAX_ID_LENGTH = 1024;
const MAX_NAME_LENGTH = 500;

const isShortText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;

function isValidResource(resource: SyncedResource): boolean {
  return (
    isShortText(resource.externalId, MAX_ID_LENGTH) &&
    typeof resource.resourceType === 'string' &&
    RESOURCE_TYPE_PATTERN.test(resource.resourceType) &&
    (resource.externalVersion === null || isShortText(resource.externalVersion, MAX_ID_LENGTH)) &&
    (resource.displayName === undefined || isShortText(resource.displayName, MAX_NAME_LENGTH)) &&
    (resource.contentSha256 === undefined || /^[0-9a-f]{64}$/.test(resource.contentSha256)) &&
    (resource.classification === undefined ||
      ['public', 'internal', 'confidential', 'restricted'].includes(resource.classification)) &&
    Array.isArray(resource.acl) &&
    resource.acl.length <= MAX_SYNC_RESOURCE_GRANTS &&
    resource.acl.every(
      (grant) =>
        PRINCIPAL_KINDS.includes(grant.principalKind) &&
        isShortText(grant.principalExternalId, MAX_ID_LENGTH) &&
        SOURCE_ACCESS.includes(grant.access),
    )
  );
}

/** Whether a page is one a stream could have produced. Each external ID may appear only once. */
export function isValidSyncPage(stream: string, page: SyncPage): boolean {
  if (!SYNC_STREAM_PATTERN.test(stream)) return false;
  if (!Array.isArray(page.resources) || page.resources.length > MAX_SYNC_PAGE_RESOURCES) {
    return false;
  }
  if (
    !Array.isArray(page.deletedExternalIds) ||
    page.deletedExternalIds.length > MAX_SYNC_PAGE_RESOURCES
  ) {
    return false;
  }
  if (page.nextCursor !== null && !isShortText(page.nextCursor, MAX_CURSOR_LENGTH)) return false;
  if (typeof page.hasMore !== 'boolean') return false;
  if (!page.resources.every(isValidResource)) return false;
  if (!page.deletedExternalIds.every((id) => isShortText(id, MAX_ID_LENGTH))) return false;
  const ids = [
    ...page.resources.map((resource) => resource.externalId),
    ...page.deletedExternalIds,
  ];
  return new Set(ids).size === ids.length;
}

export type ConfigField = { required: boolean; kind: 'email' | 'name' };

/**
 * What the service needs to know about a connector to accept a connection for it. A connector's full
 * manifest satisfies this, so a caller holding manifests can pass those.
 */
export type ConnectorTypeRule = {
  type: string;
  credential: { required: boolean };
  /** The only settings this connector takes. Left out, any that pass `isSafeConnectorConfig` do. */
  configFields?: Readonly<Record<string, ConfigField>>;
};

/**
 * The connectors this product ships. A connection for anything else is refused, and a test holds this
 * equal to the manifests. The settings are here because the web tier may not load a connector to ask
 * it, and connection pages show them, so nothing else may get in (ADR-027 D3).
 */
export const SHIPPED_CONNECTOR_RULES: readonly ConnectorTypeRule[] = [
  {
    type: 'email_smtp',
    credential: { required: true },
    configFields: {
      fromAddress: { required: true, kind: 'email' },
      fromName: { required: false, kind: 'name' },
      tlsServerName: { required: false, kind: 'name' },
    },
  },
  { type: 'inbound_webhook', credential: { required: false }, configFields: {} },
];

// Settings are shown to administrators and can never name where to connect, so a key reading like a
// credential or an address is refused for every connector, including one this file has not heard of.
const FORBIDDEN_CONFIG_KEY =
  /pass|secret|token|credential|api.?key|private|host|port|url|uri|endpoint|proxy/i;
const MAX_CONFIG_LENGTH = 4096;

function configKeysAreSafe(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(configKeysAreSafe);
  if (typeof value !== 'object' || value === null) return true;
  return Object.entries(value).every(
    ([key, inner]) => !FORBIDDEN_CONFIG_KEY.test(key) && configKeysAreSafe(inner),
  );
}

/** A plain, small object with nothing in it that reads like a credential, a host or a port. */
export function isSafeConnectorConfig(config: unknown): config is Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return false;
  return JSON.stringify(config).length <= MAX_CONFIG_LENGTH && configKeysAreSafe(config);
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const EMAIL_ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Holds a connection's settings to the fields a shipped connector takes. */
export function configMatchesFields(
  config: Record<string, unknown>,
  fields: Readonly<Record<string, ConfigField>>,
): boolean {
  if (Object.keys(config).some((key) => !Object.hasOwn(fields, key))) return false;
  return Object.entries(fields).every(([key, field]) => {
    const value = config[key];
    if (value === undefined) return !field.required;
    if (!isShortText(value, 320) || CONTROL_CHARACTER.test(value)) return false;
    return field.kind !== 'email' || EMAIL_ADDRESS.test(value);
  });
}
