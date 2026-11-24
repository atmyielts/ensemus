import {
  skillPackages,
  skillTestRuns,
  skillVersions,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { AppError } from './errors';
import { idSchema } from './ids';
import { requireSkillMember } from './skill-access';
import type { SkillVersionView } from './skills';

type Version = typeof skillVersions.$inferSelect;
type TestRun = typeof skillTestRuns.$inferSelect;

function versionView(row: Version, latest: TestRun | null): SkillVersionView {
  const boundaries: unknown =
    row.manifest && typeof row.manifest === 'object' && 'tool_boundaries' in row.manifest
      ? row.manifest.tool_boundaries
      : null;
  return {
    id: row.id,
    packageId: row.packageId,
    state: row.state as SkillVersionView['state'],
    bundleSha256: row.bundleSha256,
    sizeBytes: row.sizeBytes,
    semver: row.semver,
    digest: row.digest,
    executionKind: row.executionKind as SkillVersionView['executionKind'],
    license: row.license,
    maxClassification: row.maxClassification as SkillVersionView['maxClassification'],
    signerKeyId: row.signerKeyId,
    toolBoundaries: Array.isArray(boundaries)
      ? boundaries.filter((item): item is string => typeof item === 'string')
      : [],
    rejectCode: row.rejectCode,
    yankCode: row.yankCode,
    latestTest: latest
      ? {
          mode: latest.mode as NonNullable<SkillVersionView['latestTest']>['mode'],
          outcome: latest.outcome as NonNullable<SkillVersionView['latestTest']>['outcome'],
          fixturesTotal: latest.fixturesTotal,
          fixturesPassed: latest.fixturesPassed,
          firstFailedFixture: latest.firstFailedFixture,
          code: latest.code,
          finishedAt: latest.finishedAt,
        }
      : null,
    uploadedAt: row.uploadedAt,
    publishedAt: row.publishedAt,
    version: row.version,
  };
}

function parseId(value: string) {
  const id = idSchema.safeParse(value);
  if (!id.success) throw new AppError('INVALID_INPUT');
  return id.data;
}

async function versions(tx: Tx, context: TenantContext, scope: SQL) {
  const matched = and(eq(skillVersions.organizationId, context.organizationId), scope);
  const rows = await tx
    .select()
    .from(skillVersions)
    .where(matched)
    .orderBy(desc(skillVersions.uploadedAt), desc(skillVersions.id));
  if (!rows.length) return [];
  const latest = await tx
    .selectDistinctOn([skillTestRuns.skillVersionId], { test: skillTestRuns })
    .from(skillTestRuns)
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.organizationId, skillTestRuns.organizationId),
        eq(skillVersions.id, skillTestRuns.skillVersionId),
      ),
    )
    .where(matched)
    .orderBy(skillTestRuns.skillVersionId, desc(skillTestRuns.finishedAt), desc(skillTestRuns.id));
  const byVersion = new Map(latest.map(({ test }) => [test.skillVersionId, test]));
  return rows.map((version) => versionView(version, byVersion.get(version.id) ?? null));
}

export async function listSkillVersions(
  database: AppDatabase,
  context: TenantContext,
  packageId: string,
): Promise<readonly SkillVersionView[]> {
  const id = parseId(packageId);
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const [pkg] = await tx
      .select({ id: skillPackages.id })
      .from(skillPackages)
      .where(
        and(eq(skillPackages.organizationId, context.organizationId), eq(skillPackages.id, id)),
      );
    if (!pkg) throw new AppError('NOT_FOUND');
    return versions(tx, context, eq(skillVersions.packageId, id));
  });
}

export async function getSkillVersion(
  database: AppDatabase,
  context: TenantContext,
  skillVersionId: string,
): Promise<SkillVersionView> {
  const id = parseId(skillVersionId);
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const [row] = await versions(tx, context, eq(skillVersions.id, id));
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  });
}
