// What an inbox row says and where it leads, from the same words email uses (@ensemus/domain/
// notification-copy), so a notification reads the same wherever someone meets it. Holds references only:
// the page a row leads to checks access when it is opened.
import { notificationPath, notificationTitle } from '@ensemus/domain/notification-copy';

/** One plain sentence for a notification's kind. An unknown kind gets a general line. */
export function inboxTitle(kind: string): string {
  return notificationTitle(kind);
}

/** The page a notification's reference opens, under `/o/{organizationId}`. Anything unknown is the inbox. */
export function inboxTarget(organizationId: string, targetRef: string): string {
  return notificationPath(`/o/${organizationId}`, targetRef);
}
