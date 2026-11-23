import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { listMeetingProviderApprovals, listMeetingProviderTargets } from '@ensemus/application';
import { hasRecentMfa } from '@ensemus/application/privileged';
import { interactiveSessionOf } from '@ensemus/database';
import { canAdministerMeetings, type MeetingPurpose } from '@ensemus/domain/meeting';
import { ConfirmForm } from '@/components/confirm-form';
import {
  ActionLink,
  BackLink,
  Empty,
  ErrorNotice,
  PageHead,
  formatDateTime,
} from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { stepUpPath } from '@/lib/step-up';
import { requireTenant } from '@/server/tenant';
import { ProviderForm } from './provider-form';
import { revokeProvider } from './actions';

export const metadata = { title: 'Meeting providers | Ensemus' };

const purposeLabels: Record<MeetingPurpose, string> = {
  summarize: 'Summaries',
  extract_items: 'Suggestions',
  import_notes: 'Import notes',
};

export default async function MeetingProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { organizationId } = await params;
  const { database, context } = await requireTenant(organizationId);
  if (!canAdministerMeetings(context.role)) notFound();
  const [approvals, { models, sources }, canChange, query] = await Promise.all([
    listMeetingProviderApprovals(database, context),
    listMeetingProviderTargets(database, context),
    hasRecentMfa(database, context, 'meeting.manage', interactiveSessionOf(context)),
    searchParams,
  ]);
  const modelOptions = models.filter((entry) => entry.status === 'active');
  const sourceOptions = sources.filter((entry) => entry.status === 'active');
  const names = new Map([
    ...models.map((entry) => ['model_profile:' + entry.id, entry.name] as const),
    ...sources.map((entry) => ['connection:' + entry.id, entry.name] as const),
  ]);
  const base = '/o/' + organizationId;
  const now = new Date();
  return (
    <>
      <BackLink href={base + '/meetings'}>Meetings</BackLink>
      <PageHead
        title="Meeting providers"
        description="Set which services may handle meeting notes and what each one is approved to do."
      />
      <ErrorNotice code={query.error} />
      {(query.notice === 'approved' || query.notice === 'revoked') && (
        <p className="notice good" role="status">
          {query.notice === 'approved' ? 'Provider approved.' : 'Approval revoked.'}
        </p>
      )}
      <div className="stack">
        {canChange ? (
          <>
            {modelOptions.length > 0 && (
              <ProviderForm
                kind="model"
                organizationId={organizationId}
                options={modelOptions}
                requestKey={randomUUID()}
              />
            )}
            {sourceOptions.length > 0 && (
              <ProviderForm
                kind="source"
                organizationId={organizationId}
                options={sourceOptions}
                requestKey={randomUUID()}
              />
            )}
            {modelOptions.length === 0 && sourceOptions.length === 0 && (
              <p className="muted">
                Connect a meeting notes source or activate a model profile to approve it here.
              </p>
            )}
          </>
        ) : (
          <ActionLink
            variant="secondary"
            href={stepUpPath(organizationId, base + '/meetings/providers')}
          >
            Confirm your identity
          </ActionLink>
        )}
        <section aria-labelledby="provider-approvals-heading">
          <h2 id="provider-approvals-heading">Approvals</h2>
          {approvals.length === 0 ? (
            <Empty title="No providers approved">
              Approved providers will appear here with their expiry dates.
            </Empty>
          ) : (
            <ul className="list">
              {approvals.map((row) => {
                const name =
                  names.get(row.targetRef) ??
                  (row.kind === 'model' ? 'Model profile' : 'Notes connection');
                const status = row.revokedAt
                  ? 'Revoked'
                  : row.expiresAt <= now
                    ? 'Expired'
                    : 'Approved';
                return (
                  <li key={row.id}>
                    <div className="min-w-0">
                      <p className="row">
                        <strong>{name}</strong>
                        <Badge variant="outline">{status}</Badge>
                      </p>
                      <small className="wrap-anywhere">
                        {row.purposes.map((purpose) => purposeLabels[purpose]).join(' · ')}
                        {' · '}
                        {row.maxClassification}
                        {' · '}Terms {row.termsRef}
                        <br />
                        Expires {formatDateTime(row.expiresAt)}
                      </small>
                    </div>
                    {canChange && !row.revokedAt && row.expiresAt > now && (
                      <ConfirmForm
                        action={revokeProvider.bind(null, organizationId, row.id)}
                        fields={null}
                        summary="Revoke"
                        summaryLabel={'Revoke ' + name}
                        consequence="Future runs can no longer use this approval."
                        confirmLabel="Revoke approval"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
