// M5's additions to the connector SDK (ADR-029 D11). A sync connector reports what exists and who may read
// it. This adds reading what it says. Kept apart from the SDK's contract, so M3's file does not change.
import type { Connector, ConnectorContext, CredentialLease } from './index';

export type ContentRequest = {
  externalId: string;
  resourceType: string;
  /** Refuse past this with `ContentTooLarge`, without reading the rest. */
  maxBytes: number;
};

export type FetchedContent = {
  /** What it is, after any export a provider does. A type the parser does not know is refused there. */
  mediaType: string;
  bytes: Buffer;
  title: string;
  /** The source's revision of exactly these bytes. */
  sourceVersion: string | null;
  /** Where a person can open the original. Has to be https, and comes from the provider's own field. */
  sourceUrl: string | null;
  sourceModifiedAt: Date | null;
};

/** The source says this cannot be exported, or it needs a parser that does not exist. Not an outage. */
export class ContentUnavailable extends Error {
  override name = 'ContentUnavailable';
  constructor(readonly code: 'CONTENT_GONE' | 'CONTENT_UNSUPPORTED' | 'CONTENT_TOO_LARGE') {
    super(code);
  }
}

export interface ContentConnector<TConfig = unknown> {
  /** Reads one resource. No effect at the source, and safe to repeat. Errors carry no provider text. */
  readContent(context: ConnectorContext<TConfig>, request: ContentRequest): Promise<FetchedContent>;
}

export type KnowledgeConnector<TConfig = unknown> = Connector<TConfig> & {
  readonly content: ContentConnector<TConfig>;
  /** The worker calls this in finally, including when a bounded pass stops before its last page. */
  disposeAuthSession?(credentials: CredentialLease): void;
};

export const isKnowledgeConnector = (connector: Connector): connector is KnowledgeConnector =>
  'content' in connector && connector.content !== undefined;

/**
 * A provider's API host, named by a fixed route and never by a string from a tenant, so SSRF from settings
 * has no way in (ADR-027 D3). Each route is one egress gateway, and each gateway has one target, set by the
 * operator (ADR-027 D5). An install that does not use one has no way out through it.
 */
export const PROVIDER_ROUTES = [
  'google_api',
  'google_oauth',
  'google_gmail',
  'google_docs',
  'google_sheets',
  'ms_graph',
  'ms_login',
  'mcp_server',
] as const;
export type ProviderRoute = (typeof PROVIDER_ROUTES)[number];

/**
 * The name TLS checks for each route. Code, not configuration, so a gateway cannot redirect a token. Gmail,
 * Docs and Sheets have hosts of their own; Calendar and Drive are on www.googleapis.com; Graph covers all
 * of Microsoft 365's mail, calendar, files, workbooks and Teams (ADR-038 D6, checked 2026-11-11).
 */
export const ROUTE_TLS_NAMES: Readonly<Record<Exclude<ProviderRoute, 'mcp_server'>, string>> = {
  google_api: 'www.googleapis.com',
  google_oauth: 'oauth2.googleapis.com',
  google_gmail: 'gmail.googleapis.com',
  google_docs: 'docs.googleapis.com',
  google_sheets: 'sheets.googleapis.com',
  ms_graph: 'graph.microsoft.com',
  ms_login: 'login.microsoftonline.com',
};

export type ProviderRequest = {
  route: ProviderRoute;
  /** PATCH and PUT are for suite changes: a calendar event, a sheet's values, a workbook range. */
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Starts with `/`, with any query. A connector builds it from a provider's IDs, percent-encoded. */
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
};

export type ProviderResponse = {
  status: number;
  /** Lower-case names. Redirects are returned, and a connector must treat one as an error. */
  headers: Readonly<Record<string, string>>;
  body: Buffer;
};

/**
 * HTTPS through the gateway, for connectors. Certificates are always checked. It follows no redirect, so a
 * provider's answer cannot send a token elsewhere. Thrown errors carry a code and no response text.
 */
export interface ProviderHttpClient {
  request(request: ProviderRequest): Promise<ProviderResponse>;
  /** One operator-approved public CDN hop. No headers/credentials are accepted or inherited. */
  download?(request: {
    url: string;
    timeoutMs: number;
    maxResponseBytes: number;
    signal: AbortSignal;
  }): Promise<ProviderResponse>;
}

/** The operator binding resolves and pins a public address before creating its exact-host gateway.
 * It must reject private, loopback, link-local, metadata and DNS-rebinding targets, on every acquisition.
 * A returned relay is only for that host on HTTPS443. No implementation is inferred from a URL here. */
export interface PublicDownloadNetworks {
  forPublicHost(hostname: string, signal: AbortSignal): Promise<import('./index').ConnectorNetwork>;
}

export class ProviderHttpFailed extends Error {
  override name = 'ProviderHttpFailed';
  constructor(
    readonly code:
      | 'PROVIDER_TIMEOUT'
      | 'PROVIDER_CONNECT_FAILED'
      | 'PROVIDER_TLS_FAILED'
      | 'PROVIDER_RESPONSE_TOO_LARGE'
      | 'PROVIDER_RESPONSE_INVALID'
      | 'PROVIDER_ROUTE_UNAVAILABLE',
  ) {
    super(code);
  }
}

/** One MCP server's tool, as it described itself. All of it is untrusted (ADR-029 D11). */
export type McpToolDescription = {
  name: string;
  /** Everything it sent about the tool, unchanged. Hashed canonically, and shown to an admin. */
  definition: unknown;
};
