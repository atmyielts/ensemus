import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const uuidPk = () => uuid().primaryKey().defaultRandom();

export const identitySchema = pgSchema('identity');
export const orgSchema = pgSchema('org');
export const platformSchema = pgSchema('platform');
export const governanceSchema = pgSchema('governance');
export const secretsSchema = pgSchema('secrets');

// --- identity: global accounts. Reached only by the ensemus_auth role, except the columns of
// `users` that a tenant may see. Field names follow what Better Auth expects.
export const users = identitySchema.table('users', {
  id: uuidPk(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  /** Set by Better Auth once TOTP is confirmed (ADR-031 D8). Nothing else about MFA is on this row. */
  twoFactorEnabled: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * One-time codes an operator issues, so a first owner can get an account where sign-up is off. Only
 * the hash is kept, so a database dump holds nothing anyone could use.
 */
export const setupTokens = identitySchema.table('setup_tokens', {
  id: uuidPk(),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = identitySchema.table(
  'sessions',
  {
    id: uuidPk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = identitySchema.table(
  'accounts',
  {
    id: uuidPk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    unique('accounts_provider_account_key').on(t.providerId, t.accountId),
  ],
);

export const verifications = identitySchema.table(
  'verifications',
  {
    id: uuidPk(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

export const rateLimits = identitySchema.table('rate_limits', {
  id: uuidPk(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: 'number' }).notNull(),
});

// --- org: tenants and memberships.
export const organizations = orgSchema.table(
  'organizations',
  {
    id: uuidPk(),
    name: text().notNull(),
    commercialMode: text().notNull(),
    lifecycle: text().notNull().default('active'),
    /** Protected current restore admission; portable content and org owners cannot choose it. */
    materialRestoreGeneration: uuid().notNull().defaultRandom(),
    createdAt: createdAt(),
  },
  (t) => [
    check('organizations_mode_check', sql`${t.commercialMode} in ('cloud','byom','sovereign')`),
    check('organizations_lifecycle_check', sql`${t.lifecycle} in ('active','suspended','deleted')`),
  ],
);

export const memberships = orgSchema.table(
  'memberships',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    id: uuid().notNull().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    role: text().notNull().default('member'),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('memberships_org_user_key').on(t.organizationId, t.userId),
    index('memberships_user_idx').on(t.userId),
    check('memberships_status_check', sql`${t.status} in ('invited','active','disabled')`),
    check('memberships_role_check', sql`${t.role} in ('owner','admin','member')`),
  ],
);

// --- platform: domain events and the transactional outbox.
export const domainEvents = platformSchema.table(
  'domain_events',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    id: uuid().notNull().defaultRandom(),
    eventType: text().notNull(),
    schemaVersion: integer().notNull().default(1),
    aggregateType: text().notNull(),
    aggregateId: uuid().notNull(),
    aggregateVersion: bigint({ mode: 'number' }).notNull(),
    actorType: text().notNull(),
    actorId: uuid(),
    classification: text().notNull(),
    payload: jsonb().notNull(),
    correlationId: uuid(),
    causationId: uuid(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    index('domain_events_aggregate_idx').on(
      t.organizationId,
      t.aggregateType,
      t.aggregateId,
      t.aggregateVersion,
    ),
    check('domain_events_version_check', sql`${t.schemaVersion} > 0`),
    check(
      'domain_events_classification_check',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
  ],
);

export const outboxEvents = platformSchema.table(
  'outbox_events',
  {
    organizationId: uuid().notNull(),
    eventId: uuid().notNull(),
    state: text().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.eventId] }),
    foreignKey({
      columns: [t.organizationId, t.eventId],
      foreignColumns: [domainEvents.organizationId, domainEvents.id],
    }),
    index('outbox_events_due_idx').on(t.state, t.nextAttemptAt),
    check('outbox_events_state_check', sql`${t.state} in ('queued','published','dead')`),
  ],
);

// Inbound webhooks are recorded here once their signature has passed, so a redelivered one is applied
// only once (ADR-027 D4). Written only after verification, so nobody can use up a real event's ID.
export const inboxEvents = platformSchema.table(
  'inbox_events',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    consumerId: text().notNull(),
    eventId: uuid().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.consumerId, t.eventId] })],
);

// --- governance: append-only audit. Never holds confidential payloads.
export const auditEvents = governanceSchema.table(
  'audit_events',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    id: uuid().notNull().defaultRandom(),
    actorType: text().notNull(),
    actorId: uuid(),
    action: text().notNull(),
    targetRef: text().notNull(),
    decision: text().notNull(),
    safeReason: text(),
    correlationId: uuid(),
    /** Only on refusals: repeats of the same one in the same hour become no new row. */
    dedupeKey: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    index('audit_events_time_idx').on(t.organizationId, t.occurredAt),
    uniqueIndex('audit_events_dedupe_idx')
      .on(t.organizationId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

// --- secrets: sealed tenant secrets (ADR-024 D5). Web can insert but never read.
export const sealedSecrets = secretsSchema.table(
  'sealed_secrets',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    id: uuid().notNull(),
    purpose: text().notNull(),
    keyId: text().notNull(),
    wrappedKey: bytea().notNull(),
    iv: bytea().notNull(),
    ciphertext: bytea().notNull(),
    authTag: bytea().notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.id] })],
);
