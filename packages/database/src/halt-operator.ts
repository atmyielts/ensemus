// For the operator's command only (ADR-028 FD-15). It uses the migrator role, like the setup token, because
// a switch for every tenant has no tenant to bind and no role here has BYPASSRLS. Forced RLS confines that
// role to rows with no tenant, so this can reach no tenant's switch whatever it is asked to do. Lint blocks
// it from everything but that command. It opens one connection to the database and nothing else, so a stop
// works with the rest of the network down.
import { desc, eq, isNull } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { killSwitches } from './schema-ai';

export type OperatorSwitch =
  | { scope: 'global'; reasonCode: string }
  | { scope: 'provider'; providerKind: string; reasonCode: string };

/** A switch that is not there, or belongs to a tenant, which this role cannot tell apart by design. */
export class OperatorSwitchNotFound extends Error {
  override name = 'OperatorSwitchNotFound';
  readonly code = 'OPERATOR_SWITCH_NOT_FOUND';
  constructor() {
    super('No operator switch has that ID');
  }
}

async function withMigrator<T>(
  migratorUrl: string,
  use: (db: EnsemusDrizzle) => Promise<T>,
): Promise<T> {
  const { db, close } = openDatabase(migratorUrl, { max: 1 });
  try {
    return await use(db);
  } finally {
    // A stop that committed has happened. Failing to hang up must not make it look as if it did not.
    await close().catch(() => undefined);
  }
}

/** Writes a row with a null organization. Works with no network but the database's. */
export function engageOperatorSwitch(migratorUrl: string, input: OperatorSwitch): Promise<string> {
  return withMigrator(migratorUrl, async (db) => {
    const [row] = await db
      .insert(killSwitches)
      .values({
        scope: input.scope,
        targetRef: input.scope === 'provider' ? input.providerKind : null,
        reasonCode: input.reasonCode,
      })
      .returning({ id: killSwitches.id });
    if (!row) throw new Error('Insert returned nothing');
    return row.id;
  });
}

/** Ends a stop. Releasing one that has already ended is fine: the end state is what was asked for. */
export function releaseOperatorSwitch(migratorUrl: string, switchId: string): Promise<void> {
  return withMigrator(migratorUrl, async (db) => {
    const [row] = await db
      .select({ releasedAt: killSwitches.releasedAt })
      .from(killSwitches)
      .where(eq(killSwitches.id, switchId));
    if (!row) throw new OperatorSwitchNotFound();
    if (row.releasedAt) return;
    await db
      .update(killSwitches)
      .set({ releasedAt: new Date() })
      .where(eq(killSwitches.id, switchId));
  });
}

/** The stops in force that the operator set. Tenants' own stops are theirs, and are not visible here. */
export function listOperatorSwitches(
  migratorUrl: string,
): Promise<readonly { id: string; scope: string; targetRef: string | null; engagedAt: Date }[]> {
  return withMigrator(migratorUrl, (db) =>
    db
      .select({
        id: killSwitches.id,
        scope: killSwitches.scope,
        targetRef: killSwitches.targetRef,
        engagedAt: killSwitches.engagedAt,
      })
      .from(killSwitches)
      .where(isNull(killSwitches.releasedAt))
      .orderBy(desc(killSwitches.engagedAt)),
  );
}
