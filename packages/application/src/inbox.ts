// In-app notifications (UX-17). They work offline, and hold references, never content: the page
// resolves each one with the reader's own permissions when it is opened.
import {
  notifications,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';

export const INBOX_SIZE = 50;

/**
 * Someone's inbox, ordered in SQL so the cap only ever drops what they have already read. A reminder
 * comes first, then anything else unread, then what has been read, and each group is most recent
 * first. Something unread can sit past the cap only when more than a full page is unread, and the page
 * says so, and each one opened brings the next up.
 */
export function listMyNotifications(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        targetRef: notifications.targetRef,
        remindersSent: notifications.remindersSent,
        lastRemindedAt: notifications.lastRemindedAt,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.recipientMembershipId, context.membershipId))
      .orderBy(
        sql`case when ${notifications.readAt} is not null then 2
                 when ${notifications.remindersSent} > 0 then 0
                 else 1 end`,
        sql`coalesce(${notifications.lastRemindedAt}, ${notifications.createdAt}) desc`,
        sql`${notifications.id} desc`,
      )
      .limit(INBOX_SIZE),
  );
}

export async function countUnread(database: AppDatabase, context: TenantContext) {
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientMembershipId, context.membershipId),
          isNull(notifications.readAt),
        ),
      ),
  );
  return row?.n ?? 0;
}

export async function markRead(database: AppDatabase, context: TenantContext, id: string) {
  // Checked here, because a value the database cannot read as an ID would otherwise fail in SQL.
  if (!z.uuid().safeParse(id).success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.recipientMembershipId, context.membershipId),
        ),
      ),
  );
}

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_REMINDERS = 3;

/**
 * Raises due reminders for one tenant. A reminder moves its unread notification back to the top of the
 * recipient's inbox, up to a limit, so an approval nobody has answered keeps coming back without
 * nagging forever. This is the only channel for now, and it reaches someone when they next open
 * Ensemus: nothing goes out by email until M3. It works the same offline.
 */
export function sendDueReminders(database: AppDatabase, context: TenantContext, now: Date) {
  return withTenantTx(database, context, async (tx) => {
    const updated = await tx
      .update(notifications)
      .set({
        remindersSent: sql`${notifications.remindersSent} + 1`,
        lastRemindedAt: now,
        remindAt: sql`case when ${notifications.remindersSent} + 1 >= ${MAX_REMINDERS}
          then null else ${new Date(now.getTime() + REMINDER_INTERVAL_MS).toISOString()}::timestamptz end`,
      })
      .where(and(lte(notifications.remindAt, now), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  });
}
