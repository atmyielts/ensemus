// M11C tables: what a deployment is, what was checked about its isolation, and what a tenant requires of
// where its data lives (ADR-035 D5 and D6). Roles, grants, RLS and triggers are in reviewed SQL, migration
// 0701. Nothing here says a place is safe by itself: an operator states it and evidence backs it.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const tenancySchema = pgSchema('tenancy');

/**
 * One row at most, and none on a deployment nobody has profiled, which then behaves exactly as it always
 * has: shared, claiming no region, with cross-organization work off. Only the deploy job writes this.
 */
export const deploymentProfile = tenancySchema.table(
  'deployment_profile',
  {
    singleton: boolean().notNull().default(true),
    tier: text().notNull().default('shared'),
    /** The one organization a dedicated deployment may hold. The trigger on organizations reads it. */
    pinnedOrganizationId: uuid(),
    /** Null means this deployment makes no claim about where anything is. */
    homeRegion: text(),
    crossOrgEnabled: boolean().notNull().default(false),
    profileSha256: text().notNull(),
    appliedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'deployment_profile_pkey', columns: [t.singleton] }),
    check('deployment_profile_one_row', sql`${t.singleton}`),
    check('deployment_profile_tier_check', sql`${t.tier} in ('shared','dedicated')`),
    check(
      'deployment_profile_pin_check',
      sql`(${t.tier} = 'dedicated') = (${t.pinnedOrganizationId} is not null)`,
    ),
    check(
      'deployment_profile_dedicated_alone',
      sql`${t.tier} = 'shared' or not ${t.crossOrgEnabled}`,
    ),
    check(
      'deployment_profile_region_format',
      sql`${t.homeRegion} is null or ${t.homeRegion} ~ '^[a-z][a-z0-9-]{1,31}$'`,
    ),
    check('deployment_profile_hash_format', sql`${t.profileSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * One line per check of one aspect, append-only, so a page can show what was found and when. `passed` and
 * `failed` come from a probe that ran. `declared` is an operator's statement that no probe can make.
 */
export const isolationEvidence = tenancySchema.table(
  'isolation_evidence',
  {
    id: uuid().primaryKey().defaultRandom(),
    aspect: text().notNull(),
    result: text().notNull(),
    code: text(),
    releaseVersion: text().notNull(),
    evidenceSha256: text(),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('isolation_evidence_latest_idx').on(t.aspect, t.checkedAt),
    check(
      'isolation_evidence_aspect_check',
      sql`${t.aspect} in ('database','network','worker_pool','temporal_namespace','object_store','backups','embeddings','telemetry','key_encryption_key')`,
    ),
    check('isolation_evidence_result_check', sql`${t.result} in ('passed','failed','declared')`),
    check(
      'isolation_evidence_code_format',
      sql`${t.code} is null or ${t.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'isolation_evidence_hash_format',
      sql`${t.evidenceSha256} is null or ${t.evidenceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Where a tenant requires its data to stay, for everything or for one data class. Absent means it requires
 * nothing. The trigger refuses a region this deployment is not in, so this cannot hold an empty promise.
 */
export const residencyRequirements = tenancySchema.table(
  'residency_requirements',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    scope: text().notNull(),
    region: text().notNull(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    setByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.scope] }),
    foreignKey({
      name: 'residency_requirements_set_by_fk',
      columns: [t.organizationId, t.setByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'residency_requirements_scope_check',
      sql`${t.scope} in ('all','public','internal','confidential','restricted')`,
    ),
    check('residency_requirements_region_format', sql`${t.region} ~ '^[a-z][a-z0-9-]{1,31}$'`),
    check('residency_requirements_version_check', sql`${t.version} > 0`),
  ],
);
