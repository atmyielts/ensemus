import { artifactAclCatalog, artifactLineage, artifactWorkLinks, type Tx } from '@ensemus/database';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

/** The SQL supplies up to two retained exact-run headers, not a filtered list of visible winners. */
export function assessOnboardingOutputs(outputs: readonly { id: string; readable: boolean }[]): {
  artifactState: 'none' | 'ready' | 'ambiguous' | 'unavailable';
  artifactIds: readonly string[];
} {
  if (outputs.length > 1) return { artifactState: 'ambiguous', artifactIds: [] };
  const only = outputs[0];
  if (!only) return { artifactState: 'none', artifactIds: [] };
  if (!only.readable) return { artifactState: 'unavailable', artifactIds: [] };
  return { artifactState: 'ready', artifactIds: [only.id] };
}

export async function readOnboardingOutputs(
  tx: Tx,
  run: { organizationId: string; id: string; workUnitId: string; initiatorMembershipId: string },
) {
  const readable = and(
    eq(artifactLineage.workUnitId, run.workUnitId),
    eq(artifactLineage.viewerMembershipId, run.initiatorMembershipId),
    eq(artifactLineage.state, 'bound'),
    eq(artifactLineage.writeState, 'settled'),
    eq(artifactLineage.inventoryComplete, true),
    eq(artifactLineage.structuredInventoryComplete, true),
    eq(artifactLineage.restoreReapplyPending, false),
    isNull(artifactLineage.physicalPurgedAt),
    eq(artifactAclCatalog.sha256, artifactLineage.artifactSha256),
    eq(artifactAclCatalog.provenanceState, 'bound'),
    eq(artifactAclCatalog.alive, true),
    sql`exists(select 1 from ${artifactWorkLinks} where ${artifactWorkLinks.organizationId}=${artifactLineage.organizationId}
      and ${artifactWorkLinks.artifactId}=${artifactLineage.artifactId} and ${artifactWorkLinks.workUnitId}=${run.workUnitId}::uuid)`,
    sql`knowledge.artifact_readable(${artifactLineage.artifactId},${run.initiatorMembershipId}::uuid)`,
  );
  const outputs = await tx
    .select({
      id: artifactLineage.artifactId,
      readable: sql<boolean>`coalesce(${readable},false)`,
    })
    .from(artifactLineage)
    .leftJoin(
      artifactAclCatalog,
      and(
        eq(artifactAclCatalog.organizationId, artifactLineage.organizationId),
        eq(artifactAclCatalog.artifactId, artifactLineage.artifactId),
      ),
    )
    .where(
      and(
        eq(artifactLineage.organizationId, run.organizationId),
        eq(artifactLineage.executionKind, 'agent_run'),
        eq(artifactLineage.executionId, run.id),
        eq(artifactLineage.workUnitId, run.workUnitId),
        eq(artifactLineage.viewerMembershipId, run.initiatorMembershipId),
        // Mutable bound/blocked state cannot prove a header was never a published output.
        // Until a final-output authority exists, even abandoned/blocked attempts retain ambiguity.
      ),
    )
    // Two are enough to refuse ambiguity. Readability is a value, never a candidate WHERE filter.
    .orderBy(asc(artifactLineage.artifactId))
    .limit(2);
  return assessOnboardingOutputs(outputs);
}
