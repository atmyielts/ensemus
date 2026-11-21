import { NOTIFICATION_TOPIC_LABELS, NOTIFICATION_TOPICS } from '@ensemus/domain/mail';
import { ActionLink, Wordmark } from '@/components/ui';

export const metadata = { title: 'Email settings | Ensemus' };

export default async function UnsubscribeStatePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; topic?: string }>;
}) {
  const { state, topic } = await searchParams;
  const known = NOTIFICATION_TOPICS.find((value) => value === topic);
  const done = state === 'done' && known;
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet">
        <h1>{done ? 'You won’t get these emails any more' : 'That didn’t work'}</h1>
        <p className="lede">
          {done
            ? `We’ve stopped emailing you about ${NOTIFICATION_TOPIC_LABELS[known]}. You can turn them back on from your notification settings in Ensemus.`
            : 'The link may have run out. Choose what we email you from your notification settings in Ensemus instead.'}
        </p>
        <div className="row">
          <ActionLink href="/">Go to Ensemus</ActionLink>
        </div>
      </div>
    </main>
  );
}
