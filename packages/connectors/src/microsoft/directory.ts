// Microsoft's directory stream (CONNECT-08, ADR-038 D4): Entra groups from Graph's groups/delta, keyed by
// object ID, which is what a Graph file permission for a group carries.
//
// Delta says which groups changed, not who is in them now: its members@delta lists only additions and
// removals, and a large group's list arrives split over pages. So delta is the trigger, and each changed
// group's direct members are read whole from /members, which also gives each user's email and whether the
// account is enabled and, for a guest, accepted (that needs User.Read.All). Two things delta never
// reports, and how this covers them:
// - A group's parents. A change inside a nested group changes who its parents hold, so the parents are
//   found through memberOf and read again in the same page.
// - Members removed by deleting the member object, including a nested group. A deleted group in an
//   incremental round, or a last full pass more than a day old, sends the stream back to a full pass,
//   which re-reads every group and removes what it did not see.
//
// Wire formats checked against Microsoft Learn (group-delta, delta-query-groups, group-list-members,
// group-list-memberof) on 2026-11-11. Local fakes only: unqualified until a live run against a test tenant.
import {
  CAPABILITY_SCOPES,
  DIRECTORY_MAX_GROUPS_PER_PAGE,
  DIRECTORY_MAX_MEMBERS_PER_GROUP,
  DIRECTORY_MAX_NESTING,
  DIRECTORY_STALE_AFTER_MS,
} from '@ensemus/domain/workspace-suites';
import { CursorExpired, SyncUnavailable, type ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderResponse } from '../knowledge';
import { array, jsonResponse, object, providerId } from '../runtime/provider-oauth';
import type { DirectoryConnector, DirectoryGroup, DirectoryMember, DirectoryPage } from '../suites';
import { directoryKey, directoryName, hasDirectoryScopes } from '../google/directory';
import { graphLink } from './graph-link';

/** Every one of these, or the stream refuses before any request (ADR-038 D3). */
export const DIRECTORY_SCOPES = CAPABILITY_SCOPES.microsoft_365.directory;

const DELTA_PATH = '/v1.0/groups/delta';
// Members are selected so that a membership change puts the group in the next round at all.
const DELTA_START = `${DELTA_PATH}?$select=displayName,members`;
/**
 * How old the last full pass may be before an incremental round is not trusted to have seen removals.
 * Half of DIRECTORY_STALE_AFTER_MS, so a full pass starts, and has time to finish, before the directory
 * goes stale and its teams lose their members.
 */
export const DIRECTORY_FULL_PASS_MAX_AGE_MS = DIRECTORY_STALE_AFTER_MS / 2;
const MAX_LINK_ROUNDS = 100;

/**
 * What a member list is read with. Without `$select` Graph leaves out `accountEnabled`, `userType` and
 * `externalUserState`, and with only User.ReadBasic.All it never sends them, which is why the directory
 * capability asks for User.Read.All (ADR-038 D3). Checked against Microsoft Learn's user resource and
 * group-list-members on 2026-11-11.
 */
const MEMBER_SELECT = '$select=id,mail,userPrincipalName,accountEnabled,userType,externalUserState';

/** The mark Entra puts in a guest's sign-in name. It names the guest's home address, not one here. */
const EXTERNAL_UPN_MARK = '#ext#';

/**
 * Who a user member is here, or null when they must match nobody. An account that is not enabled, or
 * whose state Graph did not say, is nobody. A member is matched by mail, or by their sign-in name when
 * they have none. A guest only once they have accepted, and only by mail: a guest's sign-in name carries
 * #EXT# and is made from their home address, so matching on it could reach someone else's account here.
 */
export function memberUserKey(item: Record<string, unknown>): string | null {
  if (item.accountEnabled !== true) return null;
  const mail = directoryKey(item.mail);
  if (item.userType === 'Member') {
    const key = mail ?? directoryKey(item.userPrincipalName);
    return key && !key.includes(EXTERNAL_UPN_MARK) ? key : null;
  }
  if (item.userType === 'Guest' && item.externalUserState === 'Accepted') {
    return mail && !mail.includes(EXTERNAL_UPN_MARK) ? mail : null;
  }
  return null;
}

/** `full` says which round the link belongs to. `since` is when the last full pass finished. */
type Cursor = { v: 1; full: boolean; link: string; since: number | null };

export function createMicrosoftDirectory<TConfig>(deps: {
  http: ProviderHttpClient;
  withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T>;
  dispose(context: ConnectorContext): void;
}): DirectoryConnector<TConfig> {
  const now = () => Date.now();
  const read = async (
    context: ConnectorContext,
    token: string,
    path: string,
    options: { skip?: readonly number[]; expired?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    let response: ProviderResponse;
    try {
      response = await deps.http.request({
        route: 'ms_graph',
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        maxResponseBytes: 4_194_304,
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
   * Every page of a collection under `base`, following only links back to it. Null when the first read
   * is one `skip` names, such as a group deleted since delta reported it.
   */
  const collect = async (
    context: ConnectorContext,
    token: string,
    base: string,
    limit: number,
    skip: readonly number[],
  ): Promise<Record<string, unknown>[] | null> => {
    const items: Record<string, unknown>[] = [];
    let path = base;
    for (let round = 0; round < MAX_LINK_ROUNDS; round++) {
      const data = await read(context, token, path, { skip });
      if (!data) return round === 0 ? null : items;
      for (const raw of array(data.value ?? [], 1000)) items.push(object(raw));
      if (items.length >= limit || !data['@odata.nextLink']) return items;
      path = graphLink(data['@odata.nextLink'], [base.split('?')[0]!]);
    }
    return items;
  };

  /**
   * A group's direct members: users by email (memberUserKey says which), and groups by object ID.
   * Devices, contacts and apps are nobody here. A group past the member limit is cut there, which can
   * only cost access.
   */
  const membersOf = async (
    context: ConnectorContext,
    token: string,
    groupId: string,
  ): Promise<DirectoryMember[] | null> => {
    const items = await collect(
      context,
      token,
      `/v1.0/groups/${encodeURIComponent(groupId)}/members?${MEMBER_SELECT}`,
      DIRECTORY_MAX_MEMBERS_PER_GROUP,
      [404],
    );
    if (!items) return null;
    const members: DirectoryMember[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const type = item['@odata.type'];
      let member: DirectoryMember | null = null;
      if (type === '#microsoft.graph.user') {
        const email = memberUserKey(item);
        if (email) member = { kind: 'user', externalId: email };
      } else if (type === '#microsoft.graph.group') {
        member = { kind: 'group', externalId: providerId(item.id) };
      }
      if (!member || seen.has(`${member.kind}:${member.externalId}`)) continue;
      seen.add(`${member.kind}:${member.externalId}`);
      members.push(member);
      if (members.length >= DIRECTORY_MAX_MEMBERS_PER_GROUP) break;
    }
    return members;
  };

  /** The groups this one sits in directly, with their names. */
  const parentsOf = async (context: ConnectorContext, token: string, groupId: string) => {
    const items = await collect(
      context,
      token,
      `/v1.0/groups/${encodeURIComponent(groupId)}/memberOf`,
      DIRECTORY_MAX_GROUPS_PER_PAGE,
      [404],
    );
    return (items ?? [])
      .filter((item) => item['@odata.type'] === '#microsoft.graph.group')
      .map((item) => ({ id: providerId(item.id), name: item.displayName }));
  };

  const parseCursor = (raw: string | null): Cursor => {
    if (raw === null) return { v: 1, full: true, link: DELTA_START, since: null };
    let cursor: Cursor;
    try {
      cursor = JSON.parse(raw) as Cursor;
      if (
        cursor.v !== 1 ||
        typeof cursor.full !== 'boolean' ||
        (cursor.since !== null && !Number.isFinite(cursor.since))
      )
        throw new Error('INVALID_CURSOR');
      cursor.link = graphLink(`https://graph.microsoft.com${String(cursor.link)}`, [DELTA_PATH]);
    } catch {
      throw new CursorExpired();
    }
    // An incremental round cannot see members removed by deleting them, so it is trusted only for a
    // while after a full pass that could.
    if (
      !cursor.full &&
      (cursor.since === null || now() - cursor.since > DIRECTORY_FULL_PASS_MAX_AGE_MS)
    )
      throw new CursorExpired();
    return cursor;
  };

  return {
    async readGroups(context, raw): Promise<DirectoryPage> {
      if (!hasDirectoryScopes(context, DIRECTORY_SCOPES))
        throw new SyncUnavailable('SCOPE_NOT_GRANTED');
      const cursor = parseCursor(raw);
      const page = await deps.withToken(context, async (token) => {
        const data = (await read(context, token, cursor.link, { expired: raw !== null }))!;

        // A group can come more than once in a round, its member changes split over entries.
        const changed = new Map<string, unknown>();
        const deleted = new Set<string>();
        for (const item of array(data.value ?? [], 1000)) {
          const group = object(item);
          const id = providerId(group.id);
          if (group['@removed'] !== undefined) {
            deleted.add(id);
            changed.delete(id);
          } else if (!deleted.has(id)) {
            changed.set(id, group.displayName ?? changed.get(id));
          }
        }
        // Its parents were not told. Only a full pass finds what they hold now.
        if (!cursor.full && deleted.size) throw new CursorExpired();
        if (
          changed.size > DIRECTORY_MAX_GROUPS_PER_PAGE ||
          deleted.size > DIRECTORY_MAX_GROUPS_PER_PAGE
        )
          throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');

        // In an incremental round, each changed group's parents, up to the nesting limit, are changed
        // too. A full pass reads every group anyway. Too many to fit means a full pass instead, since
        // leaving a parent out would keep people a nested group has lost.
        const roots = new Map(changed);
        if (!cursor.full) {
          let level = [...changed.keys()];
          for (let depth = 0; depth < DIRECTORY_MAX_NESTING && level.length; depth++) {
            const next: string[] = [];
            for (const id of level) {
              for (const parent of await parentsOf(context, token, id)) {
                if (roots.has(parent.id)) continue;
                roots.set(parent.id, parent.name);
                next.push(parent.id);
              }
              if (roots.size > DIRECTORY_MAX_GROUPS_PER_PAGE) throw new CursorExpired();
            }
            level = next;
          }
        }

        const found = new Map<string, DirectoryGroup>();
        const names = new Map(roots);
        let level: string[] = [];
        for (const [id] of roots) {
          // Deleted since delta said otherwise: the next round says so, and a full pass follows.
          const members = await membersOf(context, token, id);
          if (!members) continue;
          found.set(id, { externalId: id, displayName: directoryName(names.get(id), id), members });
          level.push(id);
        }
        // Every group reachable from these goes in the same page, so the application flattens each one
        // from complete data. Past the page's limit the rest are left out, which costs access only.
        const tried = new Set([...found.keys(), ...deleted]);
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
                `/v1.0/groups/${encodeURIComponent(member.externalId)}?$select=id,displayName`,
                { skip: [404] },
              );
              if (!about) continue;
              const members = await membersOf(context, token, member.externalId);
              if (!members) continue;
              found.set(member.externalId, {
                externalId: member.externalId,
                displayName: directoryName(about.displayName, member.externalId),
                members,
              });
              next.push(member.externalId);
            }
          }
          level = next;
        }

        const nextLink = data['@odata.nextLink'];
        const following: Cursor = nextLink
          ? { ...cursor, link: graphLink(nextLink, [DELTA_PATH]) }
          : {
              v: 1,
              full: false,
              link: graphLink(data['@odata.deltaLink'], [DELTA_PATH]),
              since: cursor.full ? now() : cursor.since,
            };
        return {
          groups: [...found.values()],
          deletedExternalIds: cursor.full ? [...deleted] : [],
          nextCursor: JSON.stringify(following),
          hasMore: Boolean(nextLink),
          fullSync: cursor.full,
        };
      });
      if (!page.hasMore) deps.dispose(context);
      return page;
    },
  };
}
