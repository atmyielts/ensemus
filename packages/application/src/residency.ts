// Owned by the residency slice (EXP-09). See docs/06-delivery/m11c-slices.md and ADR-035 D6. A requirement is a
// tenant's own, and setting one takes an owner. The statement about where things happen is the operator's.
import {
  actorOf,
  auditEvents,
  modelProfiles,
  residencyRequirements,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
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
import { and, eq, sql } from 'drizzle-orm';
import { AUDIT_RESIDENCY_DENIED } from '@ensemus/domain/federation-events';
import { requireTenancyViewer } from './tenancy';
import type { ProcessingLocationSource, ResidencyGate } from './tenancy-ports';

export type ResidencyRequirementView = {
  scope: ResidencyScope;
  region: string;
  version: number;
  updatedAt: Date;
};

export function listResidencyRequirements(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ResidencyRequirementView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Sets one scope, or removes it with a null region, as an owner, with an audit row. A region this deployment
 * is not in is refused with RESIDENCY_REGION_NOT_OFFERED, by the trigger and by this.
 */
export function setResidencyRequirement(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { scope: ResidencyScope; region: string | null; expectedVersion: number },
): Promise<readonly ResidencyRequirementView[]> {
  throw new Error('NOT_IMPLEMENTED');
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
