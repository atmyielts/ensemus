import { describeUnsubscribe } from '@ensemus/application/platform-mail';
import { NOTIFICATION_TOPIC_LABELS } from '@ensemus/domain/mail';
import { SubmitButton } from '@/components/submit-button';
import { ActionLink, Wordmark } from '@/components/ui';
import { unsubscribeAction } from '@/server/notification-actions';
import { getRuntime } from '@/server/runtime';

export const metadata = { title: 'Stop these emails | Ensemus' };

// A button, not the link, so a mail program checking links turns nothing off. A mail program's own
// one-click unsubscribe posts to /api/mail/unsubscribe instead.
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await describeUnsubscribe(getRuntime().app, token).catch(() => null);
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        {found ? (
          <>
            <h1>Stop these emails?</h1>
            <p className="lede">
              We’ll stop emailing you about {NOTIFICATION_TOPIC_LABELS[found.topic]} for this
              company. You’ll still see everything in your Ensemus inbox, and you can turn emails
              back on whenever you like.
            </p>
            <form action={unsubscribeAction}>
              <input type="hidden" name="token" value={token} />
              <SubmitButton working="Saving">Stop these emails</SubmitButton>
            </form>
          </>
        ) : (
          <>
            <h1>That link doesn’t work any more</h1>
            <p className="lede">
              Choose what we email you from your notification settings in Ensemus instead.
            </p>
            <div className="row">
              <ActionLink href="/">Go to Ensemus</ActionLink>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
