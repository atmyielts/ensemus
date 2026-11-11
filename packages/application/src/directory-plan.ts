// The directory pass's arithmetic (ADR-038 D4), kept apart from the database so it can be tested on its own.
// Nothing here reads a row or a clock: it takes what a page says and works out who belongs where.
import {
  DIRECTORY_MAX_NESTING,
  type DirectoryMember,
  type DirectoryPage,
} from '@ensemus/domain/workspace-suites';

/** Each group a page carries, by external ID, with its direct members as the provider reported them. */
export type DirectoryGraph = ReadonlyMap<string, readonly DirectoryMember[]>;

export function directoryGraphOf(page: Pick<DirectoryPage, 'groups'>): DirectoryGraph {
  return new Map(page.groups.map((group) => [group.externalId, group.members]));
}

/**
 * How a member's email is compared with a person's here: the whole address, trimmed and in lower case.
 * Null for anything that is not an address, so it can never match a person by accident.
 */
export function directoryEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  if (/[\s\p{Cc}]/u.test(email)) return null;
  return email;
}

/**
 * The emails a group's team should hold: its own user members, and those of the groups inside it, at most
 * `maxNesting` levels down. Breadth first, and each group is visited once, so a cycle ends where it comes
 * back round and the nearest path to a group is the one that counts against the limit. A nested group the
 * graph does not hold adds nobody: reading an old copy of its members could keep someone the provider has
 * since removed, so its absence costs access rather than granting it.
 */
export function flattenDirectoryGroup(
  rootId: string,
  graph: DirectoryGraph,
  maxNesting: number = DIRECTORY_MAX_NESTING,
): readonly string[] {
  const emails = new Set<string>();
  const visited = new Set<string>([rootId]);
  let level: string[] = [rootId];
  for (let depth = 0; level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const groupId of level) {
      for (const member of graph.get(groupId) ?? []) {
        if (member.kind === 'user') {
          const email = directoryEmail(member.externalId);
          if (email) emails.add(email);
        } else if (depth < maxNesting && !visited.has(member.externalId)) {
          visited.add(member.externalId);
          next.push(member.externalId);
        }
      }
    }
    level = next;
  }
  return [...emails].sort();
}

/** What to add and what to remove to make `current` into `desired`. Each list is sorted and has no repeats. */
export function diffMembers(
  current: Iterable<string>,
  desired: Iterable<string>,
): { add: readonly string[]; remove: readonly string[] } {
  const have = new Set(current);
  const want = new Set(desired);
  return {
    add: [...want].filter((id) => !have.has(id)).sort(),
    remove: [...have].filter((id) => !want.has(id)).sort(),
  };
}

/**
 * A group's name as a team's: control characters become spaces, runs of space close up, and the external
 * ID stands in when nothing is left. The page check already refuses control characters, so this is only
 * about tidy names.
 */
export function directoryTeamName(displayName: string, externalId: string, max = 500): string {
  const tidy = displayName
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (tidy || externalId).slice(0, max);
}
