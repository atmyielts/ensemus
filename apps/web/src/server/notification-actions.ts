'use server';

// What a person chooses to get by email, and the unsubscribe link in each email (0571).
import {
  setMyNotificationPreferences,
  unsubscribeByToken,
} from '@ensemus/application/platform-mail';
import { NOTIFICATION_TOPICS } from '@ensemus/domain/mail';
import { errorCode } from '@ensemus/telemetry';
import { redirect } from 'next/navigation';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

export async function saveNotificationPreferencesAction(organizationId: string, form: FormData) {
  const { context, database } = await requireTenant(organizationId);
  const page = `/o/${organizationId}/notifications`;
  const choices = Object.fromEntries(
    NOTIFICATION_TOPICS.flatMap((topic) => {
      const value = form.get(topic);
      return typeof value === 'string' ? [[topic, value]] : [];
    }),
  );
  let target = `${page}?notice=saved`;
  try {
    await setMyNotificationPreferences(database, context, choices);
  } catch (error) {
    getRuntime().log.info('notifications.save_refused', { errorCode: errorCode(error) });
    target = `${page}?error=INVALID_INPUT`;
  }
  redirect(target);
}

/** The button on an unsubscribe page. Needs no sign-in: the link is the permission, for one topic. */
export async function unsubscribeAction(form: FormData) {
  const token = form.get('token');
  const value = typeof token === 'string' ? token : '';
  const outcome = await unsubscribeByToken(getRuntime().app, value).catch((error: unknown) => {
    getRuntime().log.error('mail.unsubscribe_failed', { errorCode: errorCode(error) });
    return { status: 'failed' as const };
  });
  redirect(
    `/unsubscribe?state=${outcome.status === 'done' ? `done&topic=${outcome.topic}` : outcome.status}`,
  );
}
