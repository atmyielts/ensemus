// Workspace suites' additions to the connector SDK (ADR-038 D2, D4). Kept apart from the SDK's contract and
// from M5's knowledge additions, so neither file changes for them.
import type { DirectoryPage } from '@ensemus/domain/workspace-suites';
import type { Connector, ConnectorContext } from './index';

export type {
  DirectoryGroup,
  DirectoryMember,
  DirectoryPage,
} from '@ensemus/domain/workspace-suites';
export { CursorExpired, SyncUnavailable } from './index';

export type PlatformOAuthProvider = 'google' | 'microsoft';

/** The operator's own app for one provider. The secret lives in memory only, for one token request. */
export type PlatformOAuthClient = { client_id: string; client_secret: string };

/**
 * The operator's apps, from the connector worker's configuration and nowhere else (ADR-038 D2). The web
 * tier never holds this: it knows only the public client ID, to build the authorize URL. A credential
 * naming `client: 'platform'` for a provider this answers null for is refused as CREDENTIAL_INVALID.
 */
export interface PlatformOAuthClients {
  get(provider: PlatformOAuthProvider): PlatformOAuthClient | null;
}

/**
 * Reads a provider's groups and their direct members, one page at a time (ADR-038 D4). No effect at the
 * source, and repeating it with the same cursor is safe. A null cursor starts a full pass, and the page
 * says whether it belongs to one. When the provider says the cursor no longer works it throws
 * CursorExpired, and the stream goes back to a full pass, as a sync stream does. Any other failure is a
 * SyncUnavailable with a code and no provider text. Nested groups come back as `group` members, and the
 * application flattens them.
 */
export interface DirectoryConnector<TConfig = unknown> {
  readGroups(context: ConnectorContext<TConfig>, cursor: string | null): Promise<DirectoryPage>;
}

export type DirectoryCapableConnector<TConfig = unknown> = Connector<TConfig> & {
  readonly directory: DirectoryConnector<TConfig>;
};

export const hasDirectory = (connector: Connector): connector is DirectoryCapableConnector =>
  'directory' in connector && (connector as { directory?: unknown }).directory !== undefined;
