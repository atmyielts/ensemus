// Google's directory stream (CONNECT-08, ADR-038 D4): groups and their direct members from the Admin SDK
// Directory API, read as a full pass every time, because the API keeps no change feed for members. Groups
// are keyed by their email in lower case, which is what a Drive permission for a group carries.
//
// Wire formats checked against the Directory API reference (groups.list, groups.get, members.list) on
// 2026-11-11. Local fakes only: unqualified until a live run against a test customer.
import {
  CAPABILITY_SCOPES,
  DIRECTORY_MAX_GROUPS_PER_PAGE,
  DIRECTORY_MAX_MEMBERS_PER_GROUP,
  DIRECTORY_MAX_NAME_LENGTH,
} from '@ensemus/domain/workspace-suites';
import { CursorExpired, SyncUnavailable, type ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderResponse } from '../knowledge';
import { array, jsonResponse, object, requiredText } from '../runtime/provider-oauth';
import type { DirectoryConnector, DirectoryGroup, DirectoryMember, DirectoryPage } from '../suites';

/** Every one of these, or the stream refuses before any request (ADR-038 D3). */
export const DIRECTORY_SCOPES = CAPABILITY_SCOPES.google_workspace.directory;

/**
 * The Directory API's documented host is admin.googleapis.com. These paths go to the google_api route
 * (www.googleapis.com), which has long served the same API under the same paths; a live run has to
 * confirm it, and a route of its own is the fix if it does not.
 */
const BASE = '/admin/directory/v1';
/** Groups listed per page. Each costs at least one members request, and its nested groups more. */
const ROOTS_PER_PAGE = 20;
const MEMBER_PAGE = 200;

type Cursor = { v: 1; page: string | null };

/** A group's or member's email as a key: lower case, one address, no spaces. Null for anything else. */
export function directoryKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  const at = email.indexOf('@');
  if (email.length > 320 || at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1)
    return null;
  return /[\s\p{Cc}]/u.test(email) ? null : email;
}

/** A provider's name, with control characters gone and within the page's limit. */
export function directoryName(value: unknown, fallback: string): string {
  const tidy =
    typeof value === 'string'
      ? value
          .replace(/\p{Cc}/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  return (tidy || fallback).slice(0, DIRECTORY_MAX_NAME_LENGTH);
}

export function hasDirectoryScopes(context: ConnectorContext, scopes: readonly string[]): boolean {
  return (
    Array.isArray(context.grantedScopes) &&
    scopes.every((scope) => context.grantedScopes?.includes(scope))
  );
}

export function createGoogleDirectory<TConfig>(deps: {
  http: ProviderHttpClient;
  withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T>;
  dispose(context: ConnectorContext): void;
}): DirectoryConnector<TConfig> {
  /**
   * One GET. `skip` lists the statuses that mean "not this one" rather than a failure, and those return
   * null. An expired page token comes back as 400, which is CursorExpired when `expired` says so.
   */
  const read = async (
    context: ConnectorContext,
    token: string,
    path: string,
    options: { skip?: readonly number[]; expired?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    let response: ProviderResponse;
    try {
      response = await deps.http.request({
        route: 'google_api',
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        maxResponseBytes: 2_097_152,
        signal: context.signal,
      });
    } catch {
      throw new SyncUnavailable(
        context.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      );
    }
    if (options.skip?.includes(response.status)) return null;
    return jsonResponse(response, options.expired ?? false);
  };

  /**
   * A group's direct members, users and groups by email. Suspended accounts and whole-customer members are
   * left out: the first should not reach anything through a group, and the second is everyone, which a
   * team is not the way to say. A group past the member limit is cut there, which can only cost access.
   */
  const membersOf = async (
    context: ConnectorContext,
    token: string,
    key: string,
    skip: readonly number[],
  ): Promise<DirectoryMember[] | null> => {
    const members: DirectoryMember[] = [];
    const seen = new Set<string>();
    let pageToken: string | null = null;
    for (
      let round = 0;
      round * MEMBER_PAGE < DIRECTORY_MAX_MEMBERS_PER_GROUP + MEMBER_PAGE;
      round++
    ) {
      const query = new URLSearchParams({
        maxResults: String(MEMBER_PAGE),
        fields: 'nextPageToken,members(email,type,status)',
      });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await read(
        context,
        token,
        `${BASE}/groups/${encodeURIComponent(key)}/members?${query}`,
        { skip },
      );
      if (!data) return null;
      for (const raw of array(data.members ?? [], MEMBER_PAGE)) {
        const member = object(raw);
        if (member.status === 'SUSPENDED') continue;
        const kind =
          member.type === 'GROUP'
            ? 'group'
            : member.type === 'USER' || member.type === 'EXTERNAL'
              ? 'user'
              : null;
        const email = directoryKey(member.email);
        if (!kind || !email || seen.has(`${kind}:${email}`)) continue;
        seen.add(`${kind}:${email}`);
        members.push({ kind, externalId: email });
        if (members.length >= DIRECTORY_MAX_MEMBERS_PER_GROUP) return members;
      }
      if (!data.nextPageToken) return members;
      pageToken = requiredText(data.nextPageToken);
    }
    return members;
  };

  return {
    async readGroups(context, raw): Promise<DirectoryPage> {
      if (!hasDirectoryScopes(context, DIRECTORY_SCOPES))
        throw new SyncUnavailable('SCOPE_NOT_GRANTED');
      let cursor: Cursor;
      try {
        cursor = raw === null ? { v: 1, page: null } : (JSON.parse(raw) as Cursor);
        if (
          cursor.v !== 1 ||
          (cursor.page !== null &&
            (typeof cursor.page !== 'string' || !cursor.page || cursor.page.length > 4096))
        )
          throw new Error('INVALID_CURSOR');
      } catch {
        throw new CursorExpired();
      }
      const page = await deps.withToken(context, async (token) => {
        const query = new URLSearchParams({
          customer: 'my_customer',
          maxResults: String(ROOTS_PER_PAGE),
          fields: 'nextPageToken,groups(email,name)',
        });
        if (cursor.page) query.set('pageToken', cursor.page);
        const listed = (await read(context, token, `${BASE}/groups?${query}`, {
          expired: cursor.page !== null,
        }))!;

        const found = new Map<string, DirectoryGroup>();
        let level: string[] = [];
        for (const item of array(listed.groups ?? [], ROOTS_PER_PAGE)) {
          const group = object(item);
          const key = directoryKey(group.email);
          if (!key || found.has(key)) continue;
          // Gone since the list was read: this pass did not see it, which is the truth.
          const members = await membersOf(context, token, key, [404]);
          if (!members) continue;
          found.set(key, { externalId: key, displayName: directoryName(group.name, key), members });
          level.push(key);
        }

        // Every group reachable from these goes in the same page, so the application can flatten each
        // one it is given from complete data, whatever depth it sits at here. Past the page's limit the
        // rest are left out, which costs access and never grants it. One outside this customer, or that
        // this account may not read, adds nobody.
        const tried = new Set(found.keys());
        while (level.length) {
          const next: string[] = [];
          for (const parent of level) {
            for (const member of found.get(parent)?.members ?? []) {
              if (member.kind !== 'group' || tried.has(member.externalId)) continue;
              if (found.size >= DIRECTORY_MAX_GROUPS_PER_PAGE) break;
              tried.add(member.externalId);
              const about = await read(
                context,
                token,
                `${BASE}/groups/${encodeURIComponent(member.externalId)}?fields=email,name`,
                { skip: [403, 404] },
              );
              if (!about) continue;
              const members = await membersOf(context, token, member.externalId, [403, 404]);
              if (!members) continue;
              found.set(member.externalId, {
                externalId: member.externalId,
                displayName: directoryName(about.name, member.externalId),
                members,
              });
              next.push(member.externalId);
            }
          }
          level = next;
        }

        const nextPage = listed.nextPageToken ? requiredText(listed.nextPageToken) : null;
        return {
          groups: [...found.values()],
          deletedExternalIds: [],
          nextCursor: nextPage ? JSON.stringify({ v: 1, page: nextPage } satisfies Cursor) : null,
          hasMore: nextPage !== null,
          fullSync: true,
        };
      });
      if (!page.hasMore) deps.dispose(context);
      return page;
    },
  };
}
