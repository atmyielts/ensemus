import { createSkillPackageSchema, updateSkillPackageSchema } from '@ensemus/contracts/skills';
import {
  skillPackages,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import type { SkillPackageState } from '@ensemus/domain/skill';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';
import { idSchema } from './ids';
import { withPrivilegeTx } from './product/privileged';
import { requireSkillMember } from './skill-access';
import type { SkillFeatureGate } from './skill-ports';
import type { SkillPackagePage, SkillPackageView } from './skills';
import { auditAction } from './work';

function packageView(row: typeof skillPackages.$inferSelect): SkillPackageView {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    origin: row.origin as SkillPackageView['origin'],
    listingId: row.listingId,
    state: row.state as SkillPackageState,
    contentClassification: row.contentClassification as SkillPackageView['contentClassification'],
    version: row.version,
    createdAt: row.createdAt,
  };
}

function packageId(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

const encodeCursor = (name: string) => Buffer.from(name, 'utf8').toString('base64url');

function cursorName(value: string) {
  if (value.length > 86) throw new AppError('INVALID_INPUT');
  const name = Buffer.from(value, 'base64url').toString('utf8');
  if (!createSkillPackageSchema.shape.name.safeParse(name).success || encodeCursor(name) !== value)
    throw new AppError('INVALID_INPUT');
  return name;
}

export async function createSkillPackage(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: {
    name: string;
    displayName: string;
    contentClassification?: SkillPackageView['contentClassification'];
  },
): Promise<SkillPackageView> {
  if (context.actorType !== 'user' || !can(context.role, 'skill.manage'))
    throw new AppError('FORBIDDEN');
  const parsed = createSkillPackageSchema.safeParse({
    name: input.name,
    display_name: input.displayName,
    content_classification: input.contentClassification,
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  if (!(await gate.isEnabled(context, 'skill_catalog'))) throw new AppError('FEATURE_NOT_ENABLED');
  const body = parsed.data;
  try {
    return await withPrivilegeTx(database, context, async (tx) => {
      const role = await requireSkillMember(tx, context, true);
      if (body.content_classification === 'public' && !can(role, 'skill.publish'))
        throw new AppError('FORBIDDEN');
      const [row] = await tx
        .insert(skillPackages)
        .values({
          organizationId: context.organizationId,
          name: body.name,
          displayName: body.display_name,
          contentClassification: body.content_classification ?? 'internal',
          ownerMembershipId: context.membershipId,
          createdByMembershipId: context.membershipId,
        })
        .returning();
      if (!row) throw new AppError('VERSION_CONFLICT');
      await auditAction(tx, context, 'skill_package.created', `skill_package:${row.id}`);
      return packageView(row);
    });
  } catch (error) {
    if (pgCode(error) === '23505') throw new AppError('SKILL_NAME_TAKEN');
    throw error;
  }
}

export async function listSkillPackages(
  database: AppDatabase,
  context: TenantContext,
  input: { after?: string; limit?: number },
): Promise<SkillPackagePage> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT');
  const after = input.after === undefined ? undefined : cursorName(input.after);
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const rows = await tx
      .select()
      .from(skillPackages)
      .where(
        and(
          eq(skillPackages.organizationId, context.organizationId),
          after === undefined ? undefined : gt(skillPackages.name, after),
        ),
      )
      .orderBy(asc(skillPackages.name))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(packageView);
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.name) : null,
    };
  });
}

export async function getSkillPackage(
  database: AppDatabase,
  context: TenantContext,
  id: string,
): Promise<SkillPackageView> {
  const scope = and(
    eq(skillPackages.organizationId, context.organizationId),
    eq(skillPackages.id, packageId(id)),
  );
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    const [row] = await tx.select().from(skillPackages).where(scope);
    if (!row) throw new AppError('NOT_FOUND');
    return packageView(row);
  });
}

export async function updateSkillPackage(
  database: AppDatabase,
  context: TenantContext,
  input: {
    packageId: string;
    expectedVersion: number;
    displayName?: string;
    state?: SkillPackageState;
    contentClassification?: SkillPackageView['contentClassification'];
  },
): Promise<SkillPackageView> {
  const parsed = updateSkillPackageSchema.safeParse({
    ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.contentClassification === undefined
      ? {}
      : { content_classification: input.contentClassification }),
  });
  if (!parsed.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  const scope = and(
    eq(skillPackages.organizationId, context.organizationId),
    eq(skillPackages.id, packageId(input.packageId)),
  );
  return withPrivilegeTx(database, context, async (tx) => {
    const role = await requireSkillMember(tx, context, true);
    const [current] = await tx.select().from(skillPackages).where(scope).for('update');
    if (!current) throw new AppError('NOT_FOUND');
    if (current.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    const next = {
      displayName: parsed.data.display_name ?? current.displayName,
      state: parsed.data.state ?? current.state,
      contentClassification: parsed.data.content_classification ?? current.contentClassification,
    };
    if (next.contentClassification !== current.contentClassification) {
      if (current.origin === 'marketplace') throw new AppError('FORBIDDEN');
      if (next.contentClassification === 'public' && !can(role, 'skill.publish'))
        throw new AppError('FORBIDDEN');
    }
    const [row] = await tx
      .update(skillPackages)
      .set({ ...next, version: current.version + 1, updatedAt: sql`now()` })
      .where(scope)
      .returning();
    if (!row) throw new AppError('VERSION_CONFLICT');
    await auditAction(tx, context, 'skill_package.updated', `skill_package:${row.id}`);
    return packageView(row);
  });
}
