// Owned by the connectors slice (CONNECT-05). See docs/06-delivery/m5-slices.md and ADR-029 D11. Tested
// against a local fake only. No real Microsoft tenant, client or token has been used.
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
import { MICROSOFT_365_MANIFEST } from '../knowledge-manifests';
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
  type OAuthScopesPort,
} from '../runtime/provider-oauth';
import { createHash } from 'node:crypto';
import {
  createSuiteToolDispatch,
  parseMailIdDomain,
  type DirectoryCapableConnector,
  type PlatformOAuthClients,
  type SuiteCapableConnector,
} from '../suites';
import { MICROSOFT_ACTION_HANDLERS, MICROSOFT_READ_HANDLERS } from './tools';
import { createMicrosoftDirectory } from './directory';
import { graphLink } from './graph-link';

export { DIRECTORY_SCOPES } from './directory';

export type Microsoft365Config = {
  /** Drives to read, by Graph ID. Never a host. */
  driveIds: readonly string[];
};

export const SCOPES_BY_STREAM = {
  drive_items: ['Files.Read.All', 'Sites.Read.All'],
  content: ['Files.Read.All', 'Sites.Read.All'],
} as const;
type Cursor = { v: 1; config: string; drive: number; drives: string[]; paths: string[] };

/** Graph v1.0 delta/permissions/content, checked against Microsoft Learn, 2026-11-06.
 * Direct content and explicitly configured public CDN gateways only; never a credentialed redirect.
 * https://learn.microsoft.com/en-us/graph/api/driveitem-delta — local fakes only, unqualified live. */
export function createMicrosoft365Connector(deps: {
  http: ProviderHttpClient;
  rotation?: OAuthRotationPort;
  /** The operator's apps, for a credential that names `client: 'platform'` (ADR-038 D2). */
  platformClients?: PlatformOAuthClients;
  /** Hears the scopes each refresh reports, so a narrowing at the provider narrows the row (D3). */
  scopes?: OAuthScopesPort;
  /**
   * The deployment's Message-ID domain for suite mail (`ENSEMUS_MAIL_ID_DOMAIN`). Checked as a host name
   * here, so a bad one stops the worker. Absent means suite mail is refused, with nothing contacted.
   */
  messageIdDomain?: string | null;
}): KnowledgeConnector<Microsoft365Config> &
  DirectoryCapableConnector<Microsoft365Config> &
  SuiteCapableConnector<Microsoft365Config> {
  const auth = createProviderAuth({
    http: deps.http,
    provider: 'microsoft',
    ...(deps.rotation ? { rotation: deps.rotation } : {}),
    ...(deps.platformClients ? { platformClients: deps.platformClients } : {}),
    ...(deps.scopes ? { scopes: deps.scopes } : {}),
  });
  const json = (context: ConnectorContext, token: string, path: string, expired = false) =>
    requestJson(
      deps.http,
      {
        route: 'ms_graph',
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
    drive: string,
    item: string,
  ): Promise<readonly SourceGrant[]> => {
    const base = `/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}/permissions`;
    let path = base;
    const grants: SourceGrant[] = [];
    for (let round = 0; round < 20; round++) {
      const response = await deps.http.request({
        route: 'ms_graph',
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        maxResponseBytes: 1_048_576,
        signal: context.signal,
      });
      if (response.status === 403 || response.status === 404) return [];
      const data = jsonResponse(response);
      for (const raw of array(data.value ?? [], 100)) {
        const permission = object(raw),
          roles = array(permission.roles ?? [], 10);
        const access = roles.includes('owner')
          ? 'owner'
          : roles.includes('write')
            ? 'write'
            : roles.includes('read')
              ? 'read'
              : null;
        if (!access) continue;
        const identities = permission.grantedToIdentitiesV2 ?? permission.grantedToIdentities;
        const single = permission.grantedToV2 ?? permission.grantedTo;
        const targets = identities ? array(identities, 100) : single ? [single] : [];
        for (const rawTarget of targets) {
          const target = object(rawTarget),
            user = target.user ? object(target.user) : null,
            siteUser = target.siteUser ? object(target.siteUser) : null,
            group = target.group ? object(target.group) : null,
            siteGroup = target.siteGroup ? object(target.siteGroup) : null;
          if (user || siteUser) {
            const email = siteUser?.email ?? user?.email;
            const external =
              typeof email === 'string'
                ? requiredText(email, 320).toLowerCase()
                : requiredText(user?.id ?? siteUser?.id);
            grants.push({ principalKind: 'user', principalExternalId: external, access });
          }
          if (group)
            grants.push({
              principalKind: 'group',
              principalExternalId: requiredText(group.id),
              access,
            });
          // SharePoint site group IDs are local integers, so a different drive cannot inherit them.
          if (siteGroup)
            grants.push({
              principalKind: 'group',
              principalExternalId: `${drive}:siteGroup:${requiredText(String(siteGroup.id))}`,
              access,
            });
        }
        if (permission.link) {
          const link = object(permission.link);
          if (link.scope === 'anonymous')
            grants.push({
              principalKind: 'anyone',
              principalExternalId: requiredText(permission.id),
              access,
            });
          else if (link.scope === 'organization')
            grants.push({ principalKind: 'domain', principalExternalId: 'organization', access });
        }
        if (grants.length > 2000) return [];
      }
      if (!data['@odata.nextLink']) return grants;
      path = graphLink(data['@odata.nextLink'], [base]);
    }
    return [];
  };
  // Suite tools for agents (ADR-038 D6): reads through `suiteReads`, changes as M3 intents through
  // `actions`. The handlers are microsoft-tools' to write, in ./tools.ts.
  const messageIdDomain = deps.messageIdDomain ? parseMailIdDomain(deps.messageIdDomain) : null;
  if (deps.messageIdDomain && !messageIdDomain) throw new Error('MAIL_ID_DOMAIN_INVALID');
  const tools = createSuiteToolDispatch({
    deps: { http: deps.http, withToken: auth.withToken, messageIdDomain },
    connectorType: MICROSOFT_365_MANIFEST.type,
    reads: MICROSOFT_READ_HANDLERS,
    actions: MICROSOFT_ACTION_HANDLERS,
  });
  return {
    manifest: MICROSOFT_365_MANIFEST,
    suiteReads: tools.suiteReads,
    actions: tools.actions,
    parseConfig(raw) {
      const parsed = driveConnectorConfigSchema.safeParse(raw);
      if (!parsed.success) throw new SyncUnavailable('CONFIG_INVALID');
      return { driveIds: [...new Set(parsed.data.drive_ids)] };
    },
    disposeAuthSession: auth.dispose,
    directory: createMicrosoftDirectory({
      http: deps.http,
      withToken: auth.withToken,
      dispose: (context) => auth.dispose(context.credentials),
    }),
    sync: {
      async readPage(context, request) {
        scopes(context, 'drive_items');
        if (
          request.stream !== 'drive_items' ||
          !Number.isInteger(request.pageSize) ||
          request.pageSize < 1 ||
          request.pageSize > 100
        )
          throw new SyncUnavailable('STREAM_INVALID');
        if (request.cursor && request.cursor.length > 1_048_576) throw new CursorExpired();
        const page = await auth.withToken(context, async (token) => {
          const drives = context.config.driveIds.length
            ? [...context.config.driveIds]
            : [providerId((await json(context, token, '/v1.0/me/drive?$select=id')).id)];
          const signature = createHash('sha256')
            .update(JSON.stringify(context.config.driveIds))
            .digest('hex');
          let cursor: Cursor;
          try {
            if (request.cursor && request.cursor.length > 1_048_576)
              throw new Error('INVALID_CURSOR');
            cursor = request.cursor
              ? (JSON.parse(request.cursor) as Cursor)
              : {
                  v: 1,
                  config: signature,
                  drive: 0,
                  drives,
                  paths: drives.map(
                    (drive) =>
                      `/v1.0/drives/${encodeURIComponent(drive)}/root/delta?$top=${request.pageSize}`,
                  ),
                };
            if (
              cursor.v !== 1 ||
              cursor.config !== signature ||
              JSON.stringify(cursor.drives) !== JSON.stringify(drives) ||
              !Number.isInteger(cursor.drive) ||
              cursor.drive < 0 ||
              cursor.drive >= drives.length ||
              !Array.isArray(cursor.paths) ||
              cursor.paths.length !== drives.length
            )
              throw new Error('INVALID_CURSOR');
          } catch {
            throw new CursorExpired();
          }
          const drive = drives[cursor.drive]!,
            base = `/v1.0/drives/${encodeURIComponent(drive)}`;
          const path = graphLink(
            `https://graph.microsoft.com${requiredText(cursor.paths[cursor.drive], 16_384)}`,
            [`${base}/root/delta`, `${base}/delta`],
          );
          const data = await json(context, token, path, !!request.cursor),
            changed = new Map<string, SyncedResource | null>();
          for (const raw of array(data.value ?? [], 100)) {
            const item = object(raw),
              itemId = providerId(item.id),
              externalId = JSON.stringify([drive, itemId]);
            if (item.deleted) {
              changed.set(externalId, null);
              continue;
            }
            if (item.folder) continue;
            if (!item.file) continue;
            const file = object(item.file);
            requiredText(file.mimeType, 256);
            changed.set(externalId, {
              externalId,
              resourceType: 'file',
              externalVersion: requiredText(item.eTag, 1024),
              displayName: requiredText(item.name, 500),
              classification: 'internal',
              acl: await permissions(context, token, drive, itemId),
            });
          }
          const next = data['@odata.nextLink'],
            delta = data['@odata.deltaLink'];
          let hasMore = false;
          if (next) {
            cursor.paths[cursor.drive] = graphLink(next, [`${base}/root/delta`, `${base}/delta`]);
            hasMore = true;
          } else {
            cursor.paths[cursor.drive] = graphLink(delta, [`${base}/root/delta`, `${base}/delta`]);
            if (cursor.drive + 1 < drives.length) {
              cursor.drive++;
              hasMore = true;
            } else cursor.drive = 0;
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
        let drive: string, item: string;
        try {
          const pair: unknown = JSON.parse(request.externalId);
          if (!Array.isArray(pair) || pair.length !== 2) throw new Error('INVALID_ID');
          drive = providerId(pair[0]);
          item = providerId(pair[1]);
        } catch {
          throw new ContentUnavailable('CONTENT_GONE');
        }
        if (
          !Number.isInteger(request.maxBytes) ||
          request.maxBytes < 1 ||
          request.maxBytes > 26_214_400
        )
          throw new ContentUnavailable('CONTENT_TOO_LARGE');
        try {
          return await auth.withToken(context, async (token) => {
            if (context.config.driveIds.length && !context.config.driveIds.includes(drive))
              throw new ContentUnavailable('CONTENT_GONE');
            if (
              !context.config.driveIds.length &&
              providerId((await json(context, token, '/v1.0/me/drive?$select=id')).id) !== drive
            )
              throw new ContentUnavailable('CONTENT_GONE');
            const base = `/v1.0/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}`;
            const metaPath = `${base}?$select=id,name,eTag,cTag,webUrl,lastModifiedDateTime,file,deleted`;
            const meta = await deps.http.request({
              route: 'ms_graph',
              method: 'GET',
              path: metaPath,
              headers: { authorization: `Bearer ${token}` },
              timeoutMs: 30_000,
              maxResponseBytes: 65_536,
              signal: context.signal,
            });
            if (meta.status === 404 || meta.status === 410)
              throw new ContentUnavailable('CONTENT_GONE');
            const value = jsonResponse(meta);
            if (value.deleted) throw new ContentUnavailable('CONTENT_GONE');
            const mime = requiredText(object(value.file).mimeType, 256),
              version = requiredText(value.eTag, 1024);
            if (!(INGESTIBLE_MEDIA_TYPES as readonly string[]).includes(mime))
              throw new ContentUnavailable('CONTENT_UNSUPPORTED');
            let content = await deps.http.request({
              route: 'ms_graph',
              method: 'GET',
              path: `${base}/content`,
              headers: { authorization: `Bearer ${token}` },
              timeoutMs: 60_000,
              maxResponseBytes: request.maxBytes,
              signal: context.signal,
            });
            if (content.status >= 300 && content.status < 400) {
              const location = content.headers.location;
              if (!location || !deps.http.download)
                throw new SyncUnavailable('DOWNLOAD_REDIRECT_DENIED');
              try {
                content = await deps.http.download({
                  url: location,
                  timeoutMs: 60_000,
                  maxResponseBytes: request.maxBytes,
                  signal: context.signal,
                });
              } catch {
                throw new SyncUnavailable('DOWNLOAD_REDIRECT_DENIED');
              }
              if (content.status >= 300 && content.status < 400)
                throw new SyncUnavailable('PROVIDER_REDIRECT');
            }
            if (content.status === 404 || content.status === 410)
              throw new ContentUnavailable('CONTENT_GONE');
            if (content.status < 200 || content.status >= 300) jsonResponse(content);
            if (content.body.length > request.maxBytes)
              throw new ContentUnavailable('CONTENT_TOO_LARGE');
            const after = await json(context, token, metaPath);
            if (after.eTag !== version || after.deleted)
              throw new SyncUnavailable('SOURCE_CHANGED');
            return {
              mediaType: mime,
              bytes: content.body,
              title: requiredText(value.name, 512),
              sourceVersion: version,
              sourceUrl: sourceUrl(value.webUrl),
              sourceModifiedAt: sourceDate(value.lastModifiedDateTime),
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
