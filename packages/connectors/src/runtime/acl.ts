// Source permissions, mapped to this tenant's people, and failing closed (ADR-027 D3).
import type { SourceGrant } from '@ensemus/domain/connector';
import type { PrincipalDirectory } from '../index';

export type MappedGrant = SourceGrant & { membershipId: string | null; teamId: string | null };

type Target = Awaited<ReturnType<PrincipalDirectory['resolve']>>;

/**
 * Maps each grant, in order. One nobody matches keeps its row with both targets empty. `domain` and
 * `anyone` map to nothing without asking: treating a provider's "anyone with the link" as anyone in this
 * tenant is a decision nobody has made. A directory that cannot answer fails the page, because reading
 * that as "nobody" would pass for a revoke.
 */
export async function mapSourceGrants(
  grants: readonly SourceGrant[],
  directory: PrincipalDirectory,
): Promise<readonly MappedGrant[]> {
  const known = new Map<string, Target>();
  const mapped: MappedGrant[] = [];
  for (const grant of grants) {
    if (grant.principalKind === 'domain' || grant.principalKind === 'anyone') {
      mapped.push({ ...grant, membershipId: null, teamId: null });
      continue;
    }
    const key = JSON.stringify([grant.principalKind, grant.principalExternalId]);
    let target = known.get(key);
    if (target === undefined) {
      target = await directory.resolve({
        kind: grant.principalKind,
        externalId: grant.principalExternalId,
      });
      known.set(key, target);
    }
    mapped.push({
      ...grant,
      membershipId: target && 'membershipId' in target ? target.membershipId : null,
      teamId: target && 'teamId' in target ? target.teamId : null,
    });
  }
  return mapped;
}
