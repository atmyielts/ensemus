import { randomUUID } from 'node:crypto';
import {
  AppError,
  getGrant,
  getFederationSettings,
  idSchema,
  listInboundItems,
  listOutboundItems,
  listWorkUnits,
} from '@ensemus/application';
import { statusUpdateBodySchema, workSummaryBodySchema } from '@ensemus/contracts/federation';
import { loadTenancyConfig } from '@ensemus/config';
import { classificationAllowed, FEDERATION_CLASSIFICATIONS } from '@ensemus/domain/federation';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { KeptInput, KeptTextarea } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { requireTenant } from '@/server/tenant';
import { updateSharedItem } from '../actions';

export const metadata = { title: 'Shared items | Ensemus' };

const kinds = { work_summary: 'Work summary', status_update: 'Status update', artifact: 'File' };
const states = {
  received: 'Received',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
  declined: 'Declined',
};
const confirmations: Record<string, string> = {
  send: 'Queued for delivery.',
  withdraw: 'Withdrawal queued.',
  accepted: 'Accepted.',
  rejected: 'Declined.',
};

function Summary({ body }: { body: unknown }) {
  const summary = workSummaryBodySchema.safeParse(body);
  if (!summary.success) return null;
  return (
    <>
      {summary.data.objective && (
        <p className="m-0 whitespace-pre-wrap wrap-anywhere">{summary.data.objective}</p>
      )}
      {summary.data.completion_criteria && (
        <p className="m-0 whitespace-pre-wrap wrap-anywhere">{summary.data.completion_criteria}</p>
      )}
      {summary.data.due_at && (
        <p className="m-0 text-sm text-muted-foreground">
          Due {formatDateTime(new Date(summary.data.due_at))}
        </p>
      )}
    </>
  );
}

function Status({ body }: { body: unknown }) {
  const update = statusUpdateBodySchema.safeParse(body);
  if (!update.success) return null;
  return (
    <>
      <div className="text-sm font-medium">{states[update.data.state]}</div>
      {update.data.note && (
        <p className="m-0 whitespace-pre-wrap wrap-anywhere">{update.data.note}</p>
      )}
    </>
  );
}

export default async function SharedItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; grantId: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  if (!loadTenancyConfig().crossOrgEnabled) notFound();
  const { organizationId, grantId } = await params;
  if (!idSchema.safeParse(grantId).success) notFound();
  const { database, context } = await requireTenant(organizationId);
  const { grant, settings } = await Promise.all([
    getGrant(database, context, grantId),
    getFederationSettings(database, context),
  ])
    .then(([grant, settings]) => ({ grant, settings }))
    .catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
      throw error;
    });
  if (!settings.available) notFound();
  const canSend = can(context.role, 'federation.share');
  const active = grant.status === 'active' && grant.expiresAt.getTime() > Date.now();
  const summary = grant.role === 'sharing';
  const supportsText = summary
    ? grant.terms.forward_kinds.includes('work_summary')
    : grant.terms.return_kinds.includes('status_update');
  const canSendText = canSend && settings.enabled && active && supportsText;
  const [sent, received, work, feedback] = await Promise.all([
    listOutboundItems(database, context, { grantId }),
    listInboundItems(database, context, { grantId }),
    canSendText && summary ? listWorkUnits(database, context) : null,
    searchParams,
  ]);
  const eligible =
    work?.items.filter((row) =>
      classificationAllowed(grant.maxClassification, row.classification),
    ) ?? [];
  const action = updateSharedItem.bind(null, organizationId, grantId);
  const feedbackMessage =
    feedback.saved && Object.hasOwn(confirmations, feedback.saved)
      ? confirmations[feedback.saved]
      : undefined;
  const sendKind = summary ? 'work_summary' : 'status_update';
  const base = '/o/' + organizationId + '/collaboration';
  return (
    <>
      <PageHead
        title={grant.counterpartyName ?? 'Shared items'}
        description="Shared items"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={base}>All grants</Link>
          </Button>
        }
      />
      <ErrorNotice code={feedback.error} />
      {feedbackMessage && !feedback.error && (
        <p className="notice good" role="status">
          {feedbackMessage}
        </p>
      )}
      {canSendText && summary && eligible.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground">
          None of your recent work is within the classification limit for this grant.
        </p>
      )}
      {canSendText && (!summary || eligible.length > 0) && (
        <section className="card min-w-0" aria-labelledby="send-shared-item">
          <h2 id="send-shared-item">Send {summary ? 'a work summary' : 'a status update'}</h2>
          <form action={action} className="grid max-w-xl min-w-0 gap-3">
            <input type="hidden" name="operation" value="send" />
            <input type="hidden" name="kind" value={sendKind} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            {summary ? (
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="share-source">Work</Label>
                <NativeSelect id="share-source" name="workId" required defaultValue="">
                  <option value="" disabled>
                    Choose work
                  </option>
                  {eligible.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.title}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="share-state">Status</Label>
                  <NativeSelect id="share-state" name="state">
                    {Object.entries(states).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="share-classification">Classification</Label>
                  <NativeSelect
                    id="share-classification"
                    name="classification"
                    defaultValue={grant.maxClassification}
                  >
                    {FEDERATION_CLASSIFICATIONS.filter((value) =>
                      classificationAllowed(grant.maxClassification, value),
                    ).map((value) => (
                      <option key={value} value={value} className="capitalize">
                        {value}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="share-title">Title to share</Label>
              <KeptInput
                keep={'share-title-' + grant.id}
                name="title"
                id="share-title"
                maxLength={200}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="share-note">{summary ? 'Summary' : 'Note'}</Label>
              <KeptTextarea
                keep={'share-note-' + grant.id}
                name="note"
                id="share-note"
                rows={3}
                maxLength={summary ? 20000 : 2000}
              />
            </div>
            <div>
              <SubmitButton working="Queuing delivery">Queue delivery</SubmitButton>
            </div>
          </form>
        </section>
      )}
      <section className="card min-w-0" aria-labelledby="received-shared-items">
        <h2 id="received-shared-items">Received</h2>
        {received.length === 0 && (
          <p className="m-0 text-sm text-muted-foreground">
            No items are available under this grant.
          </p>
        )}
        <ul className="m-0 divide-y p-0">
          {received.map((item) => (
            <li key={item.id} id={'received-' + item.id} className="grid min-w-0 gap-2 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="m-0 text-sm wrap-anywhere">{item.title}</h3>
                <Badge variant="outline" className="capitalize">
                  {item.disposition}
                </Badge>
              </div>
              <p className="m-0 text-xs wrap-anywhere text-muted-foreground">
                {kinds[item.kind]} · {item.senderName} · {formatDateTime(item.receivedAt)}
              </p>
              {item.kind === 'work_summary' && <Summary body={item.body} />}
              {item.kind === 'status_update' && <Status body={item.body} />}
              <div className="flex min-w-0 flex-wrap items-start gap-2">
                {item.hasFile && (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={
                        '/api/v1/organizations/' +
                        organizationId +
                        '/federation/inbound-items/' +
                        item.id +
                        '/file'
                      }
                    >
                      Download file
                    </a>
                  </Button>
                )}
                {canSend && item.disposition === 'pending' && (
                  <form action={action} className="flex flex-wrap gap-2">
                    <input type="hidden" name="itemId" value={item.id} />
                    <input type="hidden" name="version" value={item.version} />
                    <Button
                      variant="outline"
                      size="sm"
                      type="submit"
                      name="operation"
                      value="accepted"
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="submit"
                      name="operation"
                      value="rejected"
                    >
                      Decline
                    </Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card min-w-0" aria-labelledby="sent-shared-items">
        <h2 id="sent-shared-items">Sent</h2>
        {sent.length === 0 && (
          <p className="m-0 text-sm text-muted-foreground">
            No items are queued or recorded as sent.
          </p>
        )}
        <ul className="m-0 divide-y p-0">
          {sent.map((item) => (
            <li key={item.id} className="grid min-w-0 gap-2 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="m-0 text-sm wrap-anywhere">{item.title}</h3>
                <Badge variant="outline" className="capitalize">
                  {item.state}
                </Badge>
              </div>
              <p className="m-0 text-xs text-muted-foreground">
                {kinds[item.kind]} · {formatDateTime(item.createdAt)}
              </p>
              {canSend && (item.state === 'queued' || item.state === 'delivered') && (
                <ConfirmForm
                  action={action}
                  fields={
                    <>
                      <input type="hidden" name="operation" value="withdraw" />
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="version" value={item.version} />
                    </>
                  }
                  summary="Withdraw"
                  summaryLabel={'Withdraw ' + item.title}
                  confirmLabel="Withdraw item"
                  consequence="The other organization may already have read or downloaded this copy."
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
