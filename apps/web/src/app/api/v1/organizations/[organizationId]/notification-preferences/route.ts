import {
  getMyNotificationPreferences,
  notificationPreferencesSchema,
  setMyNotificationPreferences,
} from '@ensemus/application/platform-mail';
import { apiRoute, organizationParams, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

/** The caller's own email choices in this organization, one per topic, with defaults filled in. */
export const GET = apiRoute(organizationParams, async ({ context, database }) =>
  Response.json({ preferences: await getMyNotificationPreferences(database, context) }),
);

/**
 * Sets some or all of the caller's own choices. A topic not named is left as it is, and one set to its
 * default keeps no choice, so a better default later reaches it. Setting the same thing twice changes
 * nothing, so this needs no idempotency key.
 */
export const PUT = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, notificationPreferencesSchema);
  return Response.json({
    preferences: await setMyNotificationPreferences(database, context, body),
  });
});
