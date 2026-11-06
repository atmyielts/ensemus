// The tombstone ledger's format (ADR-026). A database restore loses the tombstones written after the
// backup, so each one is also kept outside the database, as one small object. An entry holds IDs, a
// type and a time, and this module refuses to read or write anything more. Pure, so the dispatcher,
// the restore command and the serving gate all agree on it without sharing any privileges.

export const LEDGER_PREFIX = 'tombstone-ledger/v1/';

/** The outbox event that carries a tombstone to the ledger. Its metadata is the whole entry. */
export const TOMBSTONE_RECORDED = 'tombstone.recorded';

/** Only files are tombstoned so far. Knowledge sources join this list in M3 (ADR-026). */
const TARGET_TYPES = new Set(['artifact']);

export type LedgerEntry = {
  organizationId: string;
  targetType: string;
  targetId: string;
  deletedAt: Date;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IS_UUID = new RegExp(`^${UUID}$`);
const KEY = new RegExp(`^tombstone-ledger/v1/(${UUID})/([a-z_]+)/(${UUID})\\.json$`);

export const ledgerPrefixFor = (organizationId: string) => `${LEDGER_PREFIX}${organizationId}/`;

/**
 * Deterministic, so delivering the same tombstone twice lands on the same object. Throws on anything
 * that is not exactly an ID or a known type, which also keeps every key free of names.
 */
export function ledgerKeyFor(entry: Omit<LedgerEntry, 'deletedAt'>): string {
  if (
    !IS_UUID.test(entry.organizationId) ||
    !IS_UUID.test(entry.targetId) ||
    !TARGET_TYPES.has(entry.targetType)
  ) {
    throw new Error('Not a valid ledger entry');
  }
  return `${ledgerPrefixFor(entry.organizationId)}${entry.targetType}/${entry.targetId}.json`;
}

/** What a key names, or null if it is not a ledger entry at all. */
export function parseLedgerKey(key: string): Omit<LedgerEntry, 'deletedAt'> | null {
  const match = KEY.exec(key);
  if (!match || !TARGET_TYPES.has(match[2] as string)) return null;
  return {
    organizationId: match[1] as string,
    targetType: match[2] as string,
    targetId: match[3] as string,
  };
}

export function serializeLedgerEntry(entry: LedgerEntry): Buffer {
  ledgerKeyFor(entry);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      organization_id: entry.organizationId,
      target_type: entry.targetType,
      target_id: entry.targetId,
      deleted_at: entry.deletedAt.toISOString(),
    }),
  );
}

const FIELDS = ['deleted_at', 'organization_id', 'target_id', 'target_type', 'v'];

/** Reads an object back, or null unless it is exactly an entry and agrees with its own key. */
export function parseLedgerEntry(key: string, body: string): LedgerEntry | null {
  const named = parseLedgerKey(key);
  if (!named) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const fields = raw as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== FIELDS.join()) return null;
  if (
    fields.v !== 1 ||
    fields.organization_id !== named.organizationId ||
    fields.target_type !== named.targetType ||
    fields.target_id !== named.targetId ||
    typeof fields.deleted_at !== 'string'
  ) {
    return null;
  }
  const deletedAt = new Date(fields.deleted_at);
  return Number.isNaN(deletedAt.getTime()) ? null : { ...named, deletedAt };
}
