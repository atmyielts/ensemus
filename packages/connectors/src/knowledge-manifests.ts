// What M5's connectors say they can do (ADR-029 D11). Plain data with no I/O, so the web tier may import it,
// as it may `./manifest`. The conformance suite holds each connector to its entry.
import type { ConnectorManifest } from './manifest';

/**
 * The most a Google connection asks for. Read-only: Drive metadata and permissions, and file content. A
 * stream a connection was not granted a scope for is refused, in `SCOPES_BY_STREAM`, so an admin can see
 * exactly what they agreed to, and a narrower grant reads less rather than failing obscurely.
 */
export const GOOGLE_READ_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
] as const;

export const GOOGLE_WORKSPACE_MANIFEST: ConnectorManifest = {
  type: 'google_workspace',
  version: '1',
  displayName: 'Google Workspace',
  capabilities: {
    // ADR-038 D6's changes, each an M3 intent. A test holds this to the tools whose manifest names this
    // connector. How each reconciles, and whether the provider dedupes it, is the tool's own, and these
    // two fields are only what holds for the connector as a whole.
    actions: [
      'gmail.create_draft',
      'gmail.send',
      'calendar.create_event',
      'calendar.update_event',
      'drive.create_file',
      'docs.edit',
      'sheets.write_range',
    ],
    reconcile: 'best_effort',
    nativeIdempotency: false,
    sync: { streams: ['drive_files'], pageSize: 100 },
    aclMapping: true,
    webhooks: null,
    network: 'egress_gateway',
  },
  credential: { required: true, purpose: 'connector_credential' },
};

/** The same, for Microsoft Graph. Read-only, delegated or application as the tenant's admin consented. */
export const MICROSOFT_READ_SCOPES = ['Files.Read.All', 'Sites.Read.All'] as const;

export const MICROSOFT_365_MANIFEST: ConnectorManifest = {
  type: 'microsoft_365',
  version: '1',
  displayName: 'Microsoft 365',
  capabilities: {
    // ADR-038 D6's changes, held to the tool manifests by a test, as Google's are.
    actions: [
      'outlook.create_draft',
      'outlook.send',
      'calendar.create_event',
      'calendar.update_event',
      'onedrive.create_file',
      'excel.write_range',
      'teams.post_message',
    ],
    reconcile: 'best_effort',
    nativeIdempotency: false,
    sync: { streams: ['drive_items'], pageSize: 100 },
    aclMapping: true,
    webhooks: null,
    network: 'egress_gateway',
  },
  credential: { required: true, purpose: 'connector_credential' },
};

/**
 * An MCP server. Its tools are data until an admin reviews each one. The server's address is the operator's
 * gateway target, and a tenant cannot name a host (ADR-027 D3). `actions` is empty on purpose: a write goes
 * through a reviewed tool, into an M3 external action.
 */
export const MCP_SERVER_MANIFEST: ConnectorManifest = {
  type: 'mcp_server',
  version: '1',
  displayName: 'MCP server',
  capabilities: {
    actions: [],
    reconcile: 'none',
    nativeIdempotency: false,
    sync: null,
    aclMapping: false,
    webhooks: null,
    network: 'egress_gateway',
  },
  credential: { required: false, purpose: 'connector_credential' },
};

export const KNOWLEDGE_CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  GOOGLE_WORKSPACE_MANIFEST,
  MICROSOFT_365_MANIFEST,
  MCP_SERVER_MANIFEST,
];
