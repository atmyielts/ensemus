// Owned by the residency slice (EXP-09). See docs/06-delivery/m11c-slices.md and ADR-035 D6. A requirement is a
// tenant's own, and setting one takes an owner. The statement about where things happen is the operator's.
import {
  actorOf,
  auditEvents,
  deploymentProfile,
  interactiveSessionOf,
  memberships,
  modelProfiles,
  residencyRequirements,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  checkResidency,
  REGION_PATTERN,
  RESIDENCY_SCOPES,
  RESIDENCY_SURFACES,
  residencyPosture,
  type ResidencyDecision,
  type ResidencyPolicy,
  type ResidencyPosture,
  type ResidencyScope,
  type ResidencySurface,
} from '@ensemus/domain/residency';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  AUDIT_RESIDENCY_DENIED,
  AUDIT_RESIDENCY_REQUIREMENT_REMOVED,
  AUDIT_RESIDENCY_REQUIREMENT_SET,
} from '@ensemus/domain/federation-events';
import { can } from '@ensemus/domain/policy';
import { AppError, pgCode } from './errors';
import { assertInteractivePrivilege, withPrivilegeTx } from './product/privileged';
import { auditAction } from './work';
import { requireTenancyViewer } from './tenancy';
import type { ProcessingLocationSource, ResidencyGate } from './tenancy-ports';

export type ResidencyRequirementView = {
  scope: ResidencyScope;
  region: string;
  version: number;
  updatedAt: Date;
};

function requirementsFor(tx: Tx, organizationId: string) {
  return tx
    .select({
      scope: residencyRequirements.scope,
      region: residencyRequirements.region,
      version: residencyRequirements.version,
      updatedAt: residencyRequirements.updatedAt,
    })
    .from(residencyRequirements)
    .where(eq(residencyRequirements.organizationId, organizationId))
    .orderBy(asc(residencyRequirements.scope))
    .then((rows) =>
      rows.map((row): ResidencyRequirementView => ({ ...row, scope: row.scope as ResidencyScope })),
    );
}

export function listResidencyRequirements(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ResidencyRequirementView[]> {
  return withTenantTx(database, context, async (tx) => {
    await requireTenancyViewer(tx, context);
    return requirementsFor(tx, context.organizationId);
  });
}

/** Saves a home-region requirement, or removes it, using the current owner's native session. */
export function setResidencyRequirement(
  database: AppDatabase,
  context: TenantContext,
  input: { scope: ResidencyScope; region: string | null; expectedVersion: number },
): Promise<readonly ResidencyRequirementView[]> {
  if (context.actorType !== 'user' || !interactiveSessionOf(context))
    throw new AppError('FORBIDDEN');
  const { scope, region, expectedVersion } = input;
  if (
    !RESIDENCY_SCOPES.includes(scope) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    (region !== null && !REGION_PATTERN.test(region))
  )
    throw new AppError('INVALID_INPUT');

  return withPrivilegeTx(database, context, async (tx) => {
    const org = context.organizationId;
    await requireTenancyViewer(tx, context);
    const [owner] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, org),
          eq(memberships.id, context.membershipId),
          eq(memberships.userId, context.userId),
          eq(memberships.status, 'active'),
        ),
      );
    if (!owner || !can(owner.role, 'organization.manage')) throw new AppError('FORBIDDEN');
    await assertInteractivePrivilege(tx, context, 'organization.manage');

    const target = and(
      eq(residencyRequirements.organizationId, org),
      eq(residencyRequirements.scope, scope),
    );
    const [current] = await tx
      .select({ version: residencyRequirements.version, region: residencyRequirements.region })
      .from(residencyRequirements)
      .where(target);
    if (expectedVersion !== (current?.version ?? 0)) throw new AppError('VERSION_CONFLICT');
    if (region !== null) {
      const [profile] = await tx
        .select({ homeRegion: deploymentProfile.homeRegion })
        .from(deploymentProfile);
      if (!profile?.homeRegion || region !== profile.homeRegion)
        throw new AppError('RESIDENCY_REGION_NOT_OFFERED');
    }
    if (region === (current?.region ?? null)) return requirementsFor(tx, org);

    const versioned = and(target, eq(residencyRequirements.version, expectedVersion));
    if (region === null) {
      const [removed] = await tx
        .delete(residencyRequirements)
        .where(versioned)
        .returning({ scope: residencyRequirements.scope });
      if (!removed) throw new AppError('VERSION_CONFLICT');
    } else if (current) {
      const [changed] = await tx
        .update(residencyRequirements)
        .set({
          region,
          version: current.version + 1,
          setByMembershipId: context.membershipId,
          updatedAt: new Date(),
        })
        .where(versioned)
        .returning({ scope: residencyRequirements.scope });
      if (!changed) throw new AppError('VERSION_CONFLICT');
    } else {
      const [created] = await tx
        .insert(residencyRequirements)
        .values({
          organizationId: org,
          scope,
          region,
          setByMembershipId: context.membershipId,
        })
        .onConflictDoNothing()
        .returning({ scope: residencyRequirements.scope });
      if (!created) throw new AppError('VERSION_CONFLICT');
    }
    await auditAction(
      tx,
      context,
      region === null ? AUDIT_RESIDENCY_REQUIREMENT_REMOVED : AUDIT_RESIDENCY_REQUIREMENT_SET,
      `residency:${scope}`,
    );
    return requirementsFor(tx, org);
  }).catch((error: unknown) => {
    switch (pgCode(error)) {
      case 'EN702':
        throw new AppError('RESIDENCY_REGION_NOT_OFFERED');
      case 'EN703':
        throw new AppError('VERSION_CONFLICT');
      case 'EN704':
        throw new AppError('FORBIDDEN');
      default:
        throw error;
    }
  });
}

/**
 * The real gate. Reads this tenant's requirements under its own binding and asks `checkResidency`. A denial
 * writes one audit row, with a code and no data. An error reading them is a denial: this fails closed.
 */
export function createResidencyGate({
  database,
  policy,
}: {
  database: AppDatabase;
  policy: ResidencyPolicy;
}): ResidencyGate {
  const unavailable = {
    allowed: false,
    requiredRegion: null,
    code: 'REQUIREMENTS_UNAVAILABLE',
  } as const;
  return {
    async check(context, request) {
      if (!RESIDENCY_SURFACES.includes(request.surface)) return unavailable;
      let decision: ResidencyDecision;
      try {
        const rows = await withTenantTx(database, context, (tx) =>
          tx
            .select({ scope: residencyRequirements.scope, region: residencyRequirements.region })
            .from(residencyRequirements)
            .where(eq(residencyRequirements.organizationId, context.organizationId)),
        );
        decision = RESIDENCY_SCOPES.some(
          (scope) => scope !== 'all' && scope === request.classification,
        )
          ? checkResidency({
              ...request,
              policy,
              requirements: rows.map((row) => ({
                region: row.region,
                scope: row.scope as ResidencyScope,
              })),
            })
          : unavailable;
      } catch {
        decision = unavailable;
      }
      if (!decision.allowed) {
        const { code } = decision;
        const actor = actorOf(context);
        try {
          await withTenantTx(database, context, async (tx) => {
            const key = `${AUDIT_RESIDENCY_DENIED}:${actor.actorId ?? actor.actorType}:${request.surface}:${code}`;
            await tx
              .insert(auditEvents)
              .values({
                organizationId: context.organizationId,
                ...actor,
                action: AUDIT_RESIDENCY_DENIED,
                targetRef: `residency:${request.surface}`,
                decision: 'deny',
                safeReason: code,
                dedupeKey: sql`${key} || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24')`,
              })
              .onConflictDoNothing();
          });
        } catch {
          // A database outage must never turn an unavailable decision into permission to send.
        }
      }
      return decision;
    },
  };
}

/** What this deployment states, with what each source says is really connected. Nothing more. */
export async function getResidencyPosture(
  database: AppDatabase,
  context: TenantContext,
  input: { policy: ResidencyPolicy; sources: readonly ProcessingLocationSource[] },
): Promise<ResidencyPosture> {
  const profiles = await withTenantTx(database, context, async (tx) => {
    await requireTenancyViewer(tx, context);
    return tx
      .selectDistinct({ region: modelProfiles.region, purposes: modelProfiles.allowedPurposes })
      .from(modelProfiles)
      .where(
        and(
          eq(modelProfiles.organizationId, context.organizationId),
          eq(modelProfiles.status, 'active'),
        ),
      );
  });
  const observed: Partial<Record<ResidencySurface, Set<string>>> = {};
  const add = (surface: ResidencySurface, region: string | null) => {
    // Invalid values and unavailable observations cannot match even a configured region named "unknown".
    (observed[surface] ??= new Set()).add(
      region && REGION_PATTERN.test(region) ? region : 'Unknown',
    );
  };
  for (const profile of profiles) {
    if (profile.purposes.includes('embed')) add('embeddings', profile.region);
    if (profile.purposes.some((purpose) => purpose !== 'embed')) add('inference', profile.region);
  }
  await Promise.all(
    input.sources.map(async (source) => {
      try {
        for (const region of await source.regionsFor(context)) add(source.surface, region);
      } catch {
        add(source.surface, null);
      }
    }),
  );
  const regions = Object.fromEntries(
    Object.entries(observed).map(([surface, values]) => [surface, [...values].sort()]),
  );
  return residencyPosture(input.policy, regions);
}
