// Owned by the connectors slice (CONNECT-04). See docs/06-delivery/m5-slices.md and ADR-029 D11. Tested
// against a local fake only. No real Google account, client or token has been used.
import {
  ContentUnavailable,
  type KnowledgeConnector,
  type ProviderHttpClient,
  type FetchedContent,
} from '../knowledge';
import {
  CursorExpired,
  SyncUnavailable,
  type ConnectorContext,
  type SourceGrant,
  type SyncedResource,
} from '../index';
import { GOOGLE_WORKSPACE_MANIFEST } from '../knowledge-manifests';
import { driveConnectorConfigSchema } from '@ensemus/contracts/knowledge';
import { INGESTIBLE_MEDIA_TYPES } from '@ensemus/domain/knowledge';
import {
  array,
  createProviderAuth,
  jsonResponse,
  object,
  providerId,
  requestJson,
  requiredText,
  sourceDate,
  sourceUrl,
  type OAuthRotationPort,
} from '../runtime/provider-oauth';
import { createHash } from 'node:crypto';
import type { DirectoryCapableConnector } from '../suites';
import { createGoogleDirectory, directoryKey } from './directory';

export { DIRECTORY_SCOPES } from './directory';

export type GoogleWorkspaceConfig = {
  /** Shared drives to read, by ID. Empty means what the granted account can see. Never a host. */
  driveIds: readonly string[];
};

export const SCOPES_BY_STREAM = {
  drive_files: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
  ],
  content: ['https://www.googleapis.com/auth/drive.readonly'],
} as const;
const EXPORTS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
type Cursor = {
  v: 1;
  config: string;
  phase: 'files' | 'changes';
  drive: number;
  page: string | null;
  tokens: (string | null)[];
};

/** Wire formats checked against Drive v3 files, permissions, changes and export, 2026-11-06.
 * https://developers.google.com/workspace/drive/api/reference/rest/v3 — local fakes only, unqualified live. */
export function createGoogleWorkspaceConnector(deps: {
  http: ProviderHttpClient;
  rotation?: OAuthRotationPort;
}): KnowledgeConnector<GoogleWorkspaceConfig> & DirectoryCapableConnector<GoogleWorkspaceConfig> {
  const auth = createProviderAuth({
    http: deps.http,
    provider: 'google',
    ...(deps.rotation ? { rotation: deps.rotation } : {}),
  });
  const json = (context: ConnectorContext, token: string, path: string, expired = false) =>
    requestJson(
      deps.http,
      {
        route: 'google_api',
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        maxResponseBytes: 2_097_152,
        signal: context.signal,
      },
      expired,
    );
  const permissions = async (
    context: ConnectorContext,
    token: string,
    fileId: string,
  ): Promise<readonly SourceGrant[]> => {
    const grants: SourceGrant[] = [];
    let page: string | null = null;
    for (let round = 0; round < 20; round++) {
      const query = new URLSearchParams({
        supportsAllDrives: 'true',
        pageSize: '100',
        fields: 'nextPageToken,permissions(id,type,emailAddress,domain,role,deleted)',
      });
      if (page) query.set('pageToken', page);
      const response = await deps.http.request({
        route: 'google_api',
        method: 'GET',
        path: `/drive/v3/files/${encodeURIComponent(fileId)}/permissions?${query}`,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        maxResponseBytes: 1_048_576,
        signal: context.signal,
      });
      // An account that cannot enumerate access supplies no grants; old grants must not survive this.
      if (response.status === 403 || response.status === 404) return [];
      const data = jsonResponse(response);
      for (const item of array(data.permissions ?? [], 100)) {
        const permission = object(item);
        if (permission.deleted === true) continue;
        const role = permission.role;
        const access =
          role === 'owner'
            ? 'owner'
            : role === 'writer' || role === 'organizer' || role === 'fileOrganizer'
              ? 'write'
              : role === 'reader' || role === 'commenter'
                ? 'read'
                : null;
        if (!access) continue;
        const type = permission.type;
        if (type === 'user')
          grants.push({
            principalKind: 'user',
            principalExternalId:
              typeof permission.emailAddress === 'string'
                ? requiredText(permission.emailAddress, 320).toLowerCase()
                : requiredText(permission.id),
            access,
          });
        // Keyed as the directory keys its groups, by email in lower case, so the grant finds the
        // group's team (ADR-038 D4). The permission ID is the fallback when Drive gives no email, and
        // then it matches nothing, which is the safe way round.
        else if (type === 'group')
          grants.push({
            principalKind: 'group',
            principalExternalId:
              directoryKey(permission.emailAddress) ?? requiredText(permission.id),
            access,
          });
        else if (type === 'domain')
          grants.push({
            principalKind: 'domain',
            principalExternalId: requiredText(permission.domain ?? permission.id),
            access,
          });
        else if (type === 'anyone')
          grants.push({ principalKind: 'anyone', principalExternalId: 'anyone', access });
        else return [];
      }
      if (!data.nextPageToken) return grants;
      page = requiredText(data.nextPageToken);
    }
    return [];
  };
  const resource = async (
    context: ConnectorContext,
    token: string,
    raw: unknown,
  ): Promise<SyncedResource | null> => {
    const file = object(raw),
      mime = requiredText(file.mimeType, 256);
    if (mime === 'application/vnd.google-apps.folder') return null;
    const externalId = providerId(file.id);
    return {
      externalId,
      // The SDK field is a stable resource kind; MIME is re-read from provider metadata for content.
      resourceType: 'file',
      externalVersion: requiredText(file.version, 128),
      displayName: requiredText(file.name, 500),
      classification: 'internal',
      acl: await permissions(context, token, externalId),
    };
  };
  return {
    manifest: GOOGLE_WORKSPACE_MANIFEST,
    parseConfig(raw) {
      const parsed = driveConnectorConfigSchema.safeParse(raw);
      if (!parsed.success) throw new SyncUnavailable('CONFIG_INVALID');
      return { driveIds: [...new Set(parsed.data.drive_ids)] };
    },
    disposeAuthSession: auth.dispose,
    directory: createGoogleDirectory({
      http: deps.http,
      withToken: auth.withToken,
      dispose: (context) => auth.dispose(context.credentials),
    }),
    sync: {
      async readPage(context, request) {
        scopes(context, 'drive_files');
        if (
          request.stream !== 'drive_files' ||
          !Number.isInteger(request.pageSize) ||
          request.pageSize < 1 ||
          request.pageSize > 100
        )
          throw new SyncUnavailable('STREAM_INVALID');
        const drives = context.config.driveIds.length ? context.config.driveIds : [''];
        const signature = createHash('sha256').update(JSON.stringify(drives)).digest('hex');
        let cursor: Cursor;
        try {
          if (request.cursor && request.cursor.length > 1_048_576)
            throw new Error('INVALID_CURSOR');
          cursor = request.cursor
            ? (JSON.parse(request.cursor) as Cursor)
            : {
                v: 1,
                config: signature,
                phase: 'files',
                drive: 0,
                page: null,
                tokens: drives.map(() => null),
              };
          if (
            cursor.v !== 1 ||
            cursor.config !== signature ||
            !['files', 'changes'].includes(cursor.phase) ||
            !Number.isInteger(cursor.drive) ||
            cursor.drive < 0 ||
            cursor.drive >= drives.length ||
            !Array.isArray(cursor.tokens) ||
            cursor.tokens.length !== drives.length ||
            cursor.tokens.some(
              (token) => token !== null && (typeof token !== 'string' || token.length > 4096),
            ) ||
            (cursor.page !== null && (typeof cursor.page !== 'string' || cursor.page.length > 4096))
          )
            throw new Error('INVALID_CURSOR');
        } catch {
          throw new CursorExpired();
        }
        const page = await auth.withToken(context, async (token) => {
          const drive = drives[cursor.drive]!;
          const params = new URLSearchParams({ supportsAllDrives: 'true' });
          if (drive) params.set('driveId', drive);
          const changed = new Map<string, SyncedResource | null>();
          let hasMore = false;
          if (cursor.phase === 'files') {
            if (!cursor.tokens[cursor.drive]) {
              const start = await json(
                context,
                token,
                `/drive/v3/changes/startPageToken?${params}`,
              );
              cursor.tokens[cursor.drive] = requiredText(start.startPageToken);
            }
            params.set('pageSize', String(request.pageSize));
            params.set('q', 'trashed = false');
            params.set('fields', 'nextPageToken,files(id,name,mimeType,version,trashed)');
            params.set('includeItemsFromAllDrives', 'true');
            if (drive) params.set('corpora', 'drive');
            if (cursor.page) params.set('pageToken', cursor.page);
            const data = await json(context, token, `/drive/v3/files?${params}`, !!cursor.page);
            for (const file of array(data.files ?? [], 100)) {
              const value = object(file);
              if (value.trashed === true) continue;
              const item = await resource(context, token, value);
              if (item) changed.set(item.externalId, item);
            }
            if (data.nextPageToken) {
              cursor.page = requiredText(data.nextPageToken);
              hasMore = true;
            } else if (cursor.drive + 1 < drives.length) {
              cursor.drive++;
              cursor.page = null;
              hasMore = true;
            } else {
              cursor.phase = 'changes';
              cursor.drive = 0;
              cursor.page = null;
            }
          } else {
            const current = cursor.tokens[cursor.drive];
            if (!current) throw new CursorExpired();
            params.set('pageToken', current);
            params.set('pageSize', String(request.pageSize));
            params.set('includeRemoved', 'true');
            params.set('includeItemsFromAllDrives', 'true');
            params.set(
              'fields',
              'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,version,trashed))',
            );
            const data = await json(context, token, `/drive/v3/changes?${params}`, true);
            for (const change of array(data.changes ?? [], 100)) {
              const value = object(change),
                fileId = providerId(value.fileId);
              if (value.removed === true || (value.file && object(value.file).trashed === true)) {
                changed.set(fileId, null);
                continue;
              }
              const item = await resource(context, token, value.file);
              if (item) changed.set(item.externalId, item);
            }
            if (data.nextPageToken) {
              cursor.tokens[cursor.drive] = requiredText(data.nextPageToken);
              hasMore = true;
            } else {
              cursor.tokens[cursor.drive] = requiredText(data.newStartPageToken);
              if (cursor.drive + 1 < drives.length) {
                cursor.drive++;
                hasMore = true;
              } else cursor.drive = 0;
            }
          }
          return {
            resources: [...changed.values()].filter(
              (item): item is SyncedResource => item !== null,
            ),
            deletedExternalIds: [...changed.entries()]
              .filter(([, item]) => item === null)
              .map(([id]) => id),
            nextCursor: JSON.stringify(cursor),
            hasMore,
          };
        });
        if (!page.hasMore) auth.dispose(context.credentials);
        return page;
      },
    },
    content: {
      async readContent(context, request): Promise<FetchedContent> {
        scopes(context, 'content');
        const fileId = providerId(request.externalId);
        if (
          !Number.isInteger(request.maxBytes) ||
          request.maxBytes < 1 ||
          request.maxBytes > 26_214_400
        )
          throw new ContentUnavailable('CONTENT_TOO_LARGE');
        try {
          return await auth.withToken(context, async (token) => {
            const path = `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,version,webViewLink,modifiedTime,trashed`;
            const response = await deps.http.request({
              route: 'google_api',
              method: 'GET',
              path,
              headers: { authorization: `Bearer ${token}` },
              timeoutMs: 30_000,
              maxResponseBytes: 65_536,
              signal: context.signal,
            });
            if (response.status === 404 || response.status === 410)
              throw new ContentUnavailable('CONTENT_GONE');
            const file = jsonResponse(response);
            if (file.trashed === true) throw new ContentUnavailable('CONTENT_GONE');
            const mime = requiredText(file.mimeType, 256),
              exportType = EXPORTS[mime],
              mediaType = exportType ?? mime;
            if (!(INGESTIBLE_MEDIA_TYPES as readonly string[]).includes(mediaType))
              throw new ContentUnavailable('CONTENT_UNSUPPORTED');
            const version = requiredText(file.version, 128);
            const read = await deps.http.request({
              route: 'google_api',
              method: 'GET',
              path: exportType
                ? `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportType)}`
                : `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
              headers: { authorization: `Bearer ${token}` },
              timeoutMs: 60_000,
              maxResponseBytes: request.maxBytes,
              signal: context.signal,
            });
            if (read.status === 404 || read.status === 410)
              throw new ContentUnavailable('CONTENT_GONE');
            if (read.status < 200 || read.status >= 300) jsonResponse(read);
            if (read.body.length > request.maxBytes)
              throw new ContentUnavailable('CONTENT_TOO_LARGE');
            const after = await json(context, token, path);
            if (after.version !== version || after.trashed === true)
              throw new SyncUnavailable('SOURCE_CHANGED');
            return {
              mediaType,
              bytes: read.body,
              title: requiredText(file.name, 512),
              sourceVersion: version,
              sourceUrl: sourceUrl(file.webViewLink),
              sourceModifiedAt: sourceDate(file.modifiedTime),
            };
          });
        } finally {
          auth.dispose(context.credentials);
        }
      },
    },
  };
}

function scopes(context: ConnectorContext, kind: keyof typeof SCOPES_BY_STREAM) {
  if (
    !Array.isArray(context.grantedScopes) ||
    !SCOPES_BY_STREAM[kind].some((scope) => context.grantedScopes?.includes(scope))
  )
    throw new SyncUnavailable('SCOPES_MISSING');
}
