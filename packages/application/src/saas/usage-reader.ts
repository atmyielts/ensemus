// Owned by the credits slice (BILL-04). The real UsageLedgerPort, in raw SQL over M4's `platform.usage_ledger`
// as landed on m4-foundation: `id`, `meter`, `quantity`, `unit`, `cost_micros`, `status`, `billable`, `created_at`,
// and meters such as `model_input_tokens`. Raw, so this compiles without M4's Drizzle table, and the close slice
// wires it into workers/workflow/src/saas-ports.ts after M4 merges. Reads only, as `ensemus_app`.
import { sql } from 'drizzle-orm';
import { idSchema } from '../ids';
import { UsageUnavailable, type UsageLedgerPort } from './ports';
import type { UsageEntry } from '@ensemus/saas/usage';

type LedgerRow = {
  id: string;
  meter: string;
  unit: string;
  quantity: string;
  cost_micros: string | null;
  status: string;
  billable: boolean;
  occurred_at: string;
  corrects_id: string | null;
};
const integer = (value: string) => {
  if (!/^-?\d+$/.test(value)) throw new UsageUnavailable();
  return BigInt(value);
};
function decodeCursor(cursor: string | null): { at: string; id: string } | null {
  if (cursor === null) return null;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('INVALID_CURSOR');
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'string' ||
      typeof value[1] !== 'string' ||
      !Number.isFinite(new Date(value[0]).getTime()) ||
      !idSchema.safeParse(value[1]).success
    )
      throw new Error('INVALID_CURSOR');
    return { at: value[0], id: value[1] };
  } catch {
    throw new UsageUnavailable();
  }
}

/** The cursor is `(created_at, id)`, opaque to callers, so entries written in one millisecond are not lost. */
export function createUsageLedgerReader(): UsageLedgerPort {
  return {
    async listSince(tx, context, input) {
      try {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)
          throw new UsageUnavailable();
        const cursor = decodeCursor(input.after);
        // A transaction can commit after a newer timestamp has been consumed. The indexed durable key,
        // rather than the timestamp, decides which billable entries remain. The cursor only skips
        // non-billable rows whose progress has already been recorded.
        const page = await tx.execute<LedgerRow>(
          sql`select u.id, u.meter, u.unit, u.quantity::text, u.cost_micros::text, u.status, u.billable, to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at, u.corrects_id from platform.usage_ledger u where u.organization_id=${context.organizationId}::uuid and ((u.billable and not exists (select 1 from billing.credit_ledger c where c.organization_id=u.organization_id and c.idempotency_key='usage:' || u.id::text)) or (not u.billable ${cursor ? sql`and (u.created_at,u.id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)` : sql``})) order by u.created_at,u.id limit ${input.limit + 1}`,
        );
        const rows = page.rows.slice(0, input.limit);
        const entries: UsageEntry[] = rows.map((row) => {
          const occurredAt = new Date(row.occurred_at);
          if (
            !idSchema.safeParse(row.id).success ||
            !['estimated', 'final', 'correction'].includes(row.status) ||
            !Number.isFinite(occurredAt.getTime()) ||
            typeof row.billable !== 'boolean'
          )
            throw new UsageUnavailable();
          return {
            id: row.id,
            meter: row.meter,
            unit: row.unit,
            quantity: integer(row.quantity),
            costMicros: row.cost_micros === null ? null : integer(row.cost_micros),
            status: row.status as UsageEntry['status'],
            billable: row.billable,
            occurredAt,
            correctsUsageId: row.corrects_id,
          };
        });
        const last = rows.at(-1);
        const position =
          last &&
          cursor &&
          (cursor.at > last.occurred_at || (cursor.at === last.occurred_at && cursor.id > last.id))
            ? [cursor.at, cursor.id]
            : last
              ? [last.occurred_at, last.id]
              : null;
        return {
          entries,
          nextCursor: position ? Buffer.from(JSON.stringify(position)).toString('base64url') : null,
          more: page.rows.length > input.limit,
        };
      } catch {
        throw new UsageUnavailable();
      }
    },
    async sumForPeriod(tx, context, input) {
      try {
        if (
          !Number.isFinite(input.from.getTime()) ||
          !Number.isFinite(input.to.getTime()) ||
          input.to <= input.from
        )
          throw new UsageUnavailable();
        const result = await tx.execute<{ meter: string; unit: string; quantity: string }>(
          sql`select meter,unit,sum(quantity)::text as quantity from platform.usage_ledger where organization_id=${context.organizationId}::uuid and billable=true and created_at>=${input.from.toISOString()}::timestamptz and created_at<${input.to.toISOString()}::timestamptz group by meter,unit order by meter,unit`,
        );
        return result.rows.map((row) => ({
          meter: row.meter,
          unit: row.unit,
          quantity: integer(row.quantity),
        }));
      } catch {
        throw new UsageUnavailable();
      }
    },
  };
}
