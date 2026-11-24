import { Label } from '@/components/ui/label';
import { getMyNotificationPreferences } from '@ensemus/application/platform-mail';
import type { NotificationDelivery, NotificationTopic } from '@ensemus/domain/mail';
import { SubmitButton } from '@/components/submit-button';
import { ActionLink, ErrorNotice, PageHead } from '@/components/ui';
import { saveNotificationPreferencesAction } from '@/server/notification-actions';
import { getRuntime } from '@/server/runtime';
import { orNotFound, requireTenant } from '@/server/tenant';

export const metadata = { title: 'Email notifications | Ensemus' };

const TOPICS: Record<NotificationTopic, { title: string; help: string }> = {
  approvals: {
    title: 'Approvals and reviews',
    help: 'A decision waiting for you, reminders about one, and what was decided about your work.',
  },
  answers: {
    title: 'Answers',
    help: 'When the answer to a question you asked is ready.',
  },
  billing: {
    title: 'Billing',
    help: 'New invoices, and payments that did not go through. Usually only owners get these.',
  },
  support: {
    title: 'Support',
    help: 'When our support team replies to a request you made.',
  },
  activity: {
    title: 'Everything else',
    help: 'Work you were put on, finished exports and imports, and other updates.',
  },
};

const DELIVERIES: { value: NotificationDelivery; title: string; help: string }[] = [
  { value: 'immediate', title: 'As it happens', help: 'One email for each update.' },
  {
    value: 'daily',
    title: 'Once a day',
    help: 'One summary in the morning, if anything happened.',
  },
  { value: 'off', title: 'Don’t email me', help: 'It still appears in your inbox.' },
];

export default async function NotificationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  const { actor, context, database } = await requireTenant(organizationId);
  const preferences = await orNotFound(getMyNotificationPreferences(database, context));
  const { mailEnabled } = getRuntime().config;
  return (
    <>
      <PageHead
        title="Email notifications"
        description="Choose what we email you about in this company. Everything still appears in your inbox, whatever you choose here."
      />
      <ErrorNotice code={query.error} />
      {query.notice === 'saved' && (
        <p className="notice good" role="status">
          Your email settings are saved.
        </p>
      )}
      {!mailEnabled && (
        <p className="notice" role="status">
          Email isn’t set up here yet, so for now everything comes to your inbox. Your choices are
          kept for when it is.
        </p>
      )}
      {mailEnabled && !actor.emailVerified && (
        <div className="notice" role="status">
          <p>We only email addresses that have been confirmed, so nothing is sent to you yet.</p>
          <div className="gap-above-small">
            <ActionLink variant="secondary" href={`/o/${organizationId}/security/email`}>
              Confirm your email address
            </ActionLink>
          </div>
        </div>
      )}
      <form
        className="card fields form-width"
        action={saveNotificationPreferencesAction.bind(null, organizationId)}
      >
        {preferences.map((preference) => (
          <section
            key={preference.topic}
            className="form-section"
            aria-labelledby={`topic-${preference.topic}`}
          >
            <h2 id={`topic-${preference.topic}`}>{TOPICS[preference.topic].title}</h2>
            <p className="muted">{TOPICS[preference.topic].help}</p>
            <fieldset className="group">
              <legend className="visually-hidden">
                How to email you about {TOPICS[preference.topic].title.toLowerCase()}
              </legend>
              <div className="choice-list">
                {DELIVERIES.map((delivery) => (
                  <Label key={delivery.value} className="choice">
                    <input
                      type="radio"
                      name={preference.topic}
                      value={delivery.value}
                      defaultChecked={preference.delivery === delivery.value}
                    />
                    <strong>{delivery.title}</strong>
                    <small>{delivery.help}</small>
                  </Label>
                ))}
              </div>
            </fieldset>
          </section>
        ))}
        <p className="muted">
          A few emails always come, because they are about your company’s access to Ensemus: when
          someone from support asks to look at something, or your company’s account changes.
        </p>
        <div>
          <SubmitButton working="Saving">Save email settings</SubmitButton>
        </div>
      </form>
    </>
  );
}
