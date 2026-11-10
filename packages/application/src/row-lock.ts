import { getTableName } from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';

/** PostgreSQL's FOR ... OF accepts a relation name, never schema.relation. Drizzle renders a
 * schema table qualified here; its alias form emits the same existing relation's bare name. */
export const rowLockTarget = <T extends PgTable>(table: T) => alias(table, getTableName(table));
