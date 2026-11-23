import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { getMeetingSettings, listMeetings } from '@ensemus/application';
import { canAdministerMeetings } from '@ensemus/domain/meeting';
import { hasRecentMfa } from '@ensemus/application/privileged';
import { interactiveSessionOf } from '@ensemus/database';
import { Empty, PageHead, formatDateTime } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { requireTenant } from '@/server/tenant';
import { stepUpPath } from '@/lib/step-up';
import { MeetingForm } from './meeting-form';
export const metadata = { title: 'Meetings | Ensemus' };
export default async function MeetingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { organizationId } = await params,
    { actor, database, context } = await requireTenant(organizationId),
    query = await searchParams;
  const [settings, page] = await Promise.all([
    getMeetingSettings(database, context),
    listMeetings(database, context, query.cursor ? { after: query.cursor } : {}),
  ]);
  const admin = canAdministerMeetings(context.role),
    ready = admin
      ? await hasRecentMfa(database, context, 'meeting.manage', interactiveSessionOf(context))
      : false;
  return (
    <>
      <PageHead title="Meetings" description="Private notes for the people in the room." />
      {settings.enabled ? (
        <MeetingForm
          summary="New meeting"
          disclosureClassName="group"
          key={actor.userId + '-create'}
          kind="create"
          organizationId={organizationId}
          requestKey={randomUUID()}
        />
      ) : (
        <p className="notice">
          New meetings are switched off.
          {admin
            ? ' Choose a notice reference in meeting settings to get started.'
            : ' An administrator can turn them on.'}
        </p>
      )}
      <section aria-label="Meetings list">
        {page.items.length ? (
          <ul className="list">
            {page.items.map((row) => (
              <li key={row.id}>
                <div className="row spread">
                  <Link href={`/o/${organizationId}/meetings/${row.id}`}>
                    {row.title ?? 'Private meeting'}
                  </Link>
                  <Badge variant="outline">
                    {row.status === 'purged'
                      ? 'Removed'
                      : row.consent === 'complete'
                        ? 'Everyone agreed'
                        : row.consent === 'pending'
                          ? 'Awaiting consent'
                          : row.consent}
                  </Badge>
                </div>
                <p className="muted">
                  {formatDateTime(row.occurredAt)} · {row.classification}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No meetings to show">
            Meetings you organize or attend appear here. Administrators can also see other meetings’
            status.
          </Empty>
        )}
        {page.nextCursor && (
          <Link href={`?cursor=${encodeURIComponent(page.nextCursor)}`}>More meetings</Link>
        )}
      </section>
      {admin &&
        (ready ? (
          <MeetingForm
            summary="Meeting settings"
            disclosureClassName="group"
            key={actor.userId + '-settings'}
            kind="settings"
            organizationId={organizationId}
            version={settings.version}
            noticeRef={settings.noticeRef}
            enabled={settings.enabled}
          />
        ) : (
          <details className="group">
            <summary>Meeting settings</summary>
            <p>
              <Link href={stepUpPath(organizationId, `/o/${organizationId}/meetings`)}>
                Confirm your identity
              </Link>{' '}
              to change meeting settings.
            </p>
          </details>
        ))}
    </>
  );
}
