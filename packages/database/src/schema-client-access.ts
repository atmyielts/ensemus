import { foreignKey, pgSchema, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { memberships } from './schema';
import { clients } from './schema-work';

/** Named access is explicit and tenant-bound. Ownership lives on the client, never in a role name. */
export const clientReaders = pgSchema('work').table(
  'client_readers',
  {
    organizationId: uuid().notNull(),
    clientId: uuid().notNull(),
    membershipId: uuid().notNull(),
    grantedByMembershipId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'client_readers_pk',
      columns: [t.organizationId, t.clientId, t.membershipId],
    }),
    foreignKey({
      name: 'client_readers_client_tenant_fk',
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'client_readers_member_tenant_fk',
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'client_readers_grantor_tenant_fk',
      columns: [t.organizationId, t.grantedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
  ],
);
