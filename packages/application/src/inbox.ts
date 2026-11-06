// In-app notifications (UX-17). They work offline, and hold references, never content: the page
// resolves each one with the reader's own permissions when it is opened.
import {
  notifications,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';

export function listMyNotifications(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        targetRef: notifications.targetRef,
        remindersSent: notifications.remindersSent,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.recipientMembershipId, context.membershipId))
      .orderBy(desc(notifications.createdAt))
      .limit(50),
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
 * Raises due reminders for one tenant. Each resurfaces the unread notification, up to a limit, so an
 * approval nobody has answered keeps coming back without nagging forever.
 */
export function sendDueReminders(database: AppDatabase, context: TenantContext, now: Date) {
  return withTenantTx(database, context, async (tx) => {
    const updated = await tx
      .update(notifications)
      .set({
        remindersSent: sql`${notifications.remindersSent} + 1`,
        remindAt: sql`case when ${notifications.remindersSent} + 1 >= ${MAX_REMINDERS}
          then null else ${new Date(now.getTime() + REMINDER_INTERVAL_MS).toISOString()}::timestamptz end`,
      })
      .where(and(lte(notifications.remindAt, now), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  });
}
