// The bridge (ADR-035 D2). The only code that connects as `ensemus_federation`, the one role that writes to
// one tenant from another. Lint keeps this out of everything except the federation worker and its
// Activities. Each transaction binds one grant, and the role's policies see nothing outside it.
import { sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import type { Tx } from './tenant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No other way to use this connection exists, so there is no query that runs with no grant bound. */
export class BridgeDatabase {
  readonly #db: EnsemusDrizzle;
  constructor(db: EnsemusDrizzle) {
    this.#db = db;
  }
  /** Binds one grant. Keep it short: bytes are copied before this, and never inside it. */
  withGrant<T>(grantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(grantId)) throw new Error('INVALID_GRANT_ID');
    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.federation_grant_id', ${grantId.toLowerCase()}, true)`,
      );
      return fn(tx);
    });
  }
}

export function openBridgeDatabase(url: string) {
  const { db, close } = openDatabase(url, { max: 2 });
  return { db: new BridgeDatabase(db), close };
}

export * from './federation-crossing';
