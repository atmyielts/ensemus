import { randomUUID } from 'node:crypto';
import {
  listModelQualifications,
  listModelWorkloadApprovals,
} from '@ensemus/application/knowledge/model-jobs';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import {
  ActionLink,
  BackLink,
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatDate,
  PageHead,
} from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { approveWorkloadAction, revokeWorkloadAction } from '../actions';
import { ModelBoundsFields } from '../model-bounds-fields';
import { PURPOSE_LABEL, WORKLOAD_LABEL, workloadState } from '../workload-form';

export const metadata = { title: 'Knowledge workload approvals | Ensemus' };

export default async function ModelWorkloadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; after?: string; qualification_after?: string }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  const { database, context } = await requireTenant(organizationId);
  if (!can(context.role, 'model.activate') || !can(context.role, 'budget.manage')) notFound();
  const [approvals, qualifications] = await Promise.all([
    listModelWorkloadApprovals(database, context, query.after),
    listModelQualifications(
      database,
      context,
      query.qualification_after ? { after: query.qualification_after } : {},
    ),
  ]);
  const usable = qualifications.items.filter((q) => q.usable);
  return (
    <>
      <BackLink href={`/o/${organizationId}/settings/models`}>All models</BackLink>
      <PageHead
        title="Knowledge workload approvals"
        description="Let one kind of Knowledge work (a workload, such as search indexing or answering questions) use models that passed their tests, within limits you set and until a date you choose."
      />
      <ErrorNotice code={query.error} />
      <p className="notice" role="status">
        Without a usable approval, search matches words only and paid AI generation is refused. An
        approval is a ceiling, not a promise to spend: access, model rules, the company budget and
        the model’s availability are still checked on every call.
      </p>
      <div className="stack">
        <section className="card" aria-labelledby="workload-history-heading">
          <h2 id="workload-history-heading">Recorded approvals</h2>
          {!approvals.items.length ? (
            <Empty title="No approvals yet">
              Approvals you record below are listed here, with their limits and expiry.
            </Empty>
          ) : (
            <ul className="list">
              {approvals.items.map((approval) => (
                <li key={approval.id} className="block">
                  <div className="stack">
                    <div className="spread">
                      <strong>{WORKLOAD_LABEL[approval.kind] ?? approval.kind}</strong>
                      <span className="badge">{workloadState(approval)}</span>
                    </div>
                    <dl className="facts">
                      <div>
                        <dt>Approval reference</dt>
                        <dd>{approval.id}</dd>
                      </div>
                      <div>
                        <dt>Scope</dt>
                        <dd>
                          {approval.scope}
                          {approval.sourceId
                            ? ` · ${approval.sourceId}`
                            : approval.connectionId
                              ? ` · ${approval.connectionId}`
                              : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>Highest permitted classification</dt>
                        <dd>
                          <ClassificationBadge value={approval.maxClassification} />
                        </dd>
                      </div>
                      <div>
                        <dt>Purposes</dt>
                        <dd>
                          {approval.purposes
                            .map((p) => PURPOSE_LABEL[p as keyof typeof PURPOSE_LABEL] ?? p)
                            .join(', ')}
                        </dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>{formatDate(new Date(approval.expiresAt))}</dd>
                      </div>
                      <div>
                        <dt>Per-job ceilings</dt>
                        <dd>
                          {approval.maxCalls} calls; {approval.maxTotalTokens} total tokens;{' '}
                          {approval.maxCostMicros} micro-USD; {approval.timeoutSeconds} seconds
                        </dd>
                      </div>
                      <div>
                        <dt>Per-call token ceilings</dt>
                        <dd>
                          {approval.maxInputTokens} input; {approval.maxOutputTokens} output
                        </dd>
                      </div>
                      <div>
                        <dt>Capability evidence</dt>
                        <dd>
                          <ul>
                            {approval.qualifications.map((q) => (
                              <li key={q.id}>
                                {q.id}
                                {q.usable ? '' : ' · unavailable'}
                              </li>
                            ))}
                          </ul>
                        </dd>
                      </div>
                    </dl>
                    {!approval.revokedAt && (
                      <ConfirmForm
                        action={revokeWorkloadAction}
                        fields={
                          <>
                            <input type="hidden" name="organizationId" value={organizationId} />
                            <input type="hidden" name="approvalId" value={approval.id} />
                          </>
                        }
                        summary="Revoke approval"
                        summaryLabel={`Revoke approval ${approval.id}`}
                        consequence="Stop new model calls under this approval. Calls already sent may still settle. Revocation does not erase usage or retry an unknown outcome."
                        confirmLabel="Revoke approval"
                        confirmFullLabel={`Confirm revocation of ${approval.id}`}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {approvals.nextCursor && (
            <p className="link-line">
              <Link href={`?after=${approvals.nextCursor}#workload-history-heading`}>
                More approvals
              </Link>
            </p>
          )}
        </section>
        <section className="card" aria-labelledby="approve-workload-heading">
          <h2 id="approve-workload-heading">Approve a bounded workload</h2>
          <p className="muted">
            Only current, passed capability evidence (a model’s test result for one use) can be
            chosen. Approving needs a recent sign-in that meets your company sign-in rules, and a
            fresh code from your authenticator app. Revoking does not need a new code.
          </p>
          {!usable.length ? (
            <Empty
              title="No tested models to choose from"
              action={
                <ActionLink variant="secondary" href={`/o/${organizationId}/settings/models`}>
                  Qualify a model
                </ActionLink>
              }
            >
              Test a model for a use first, and its result can be chosen here.
            </Empty>
          ) : (
            <form className="fields gap-above" action={approveWorkloadAction}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <label>
                Workload
                <select name="kind" defaultValue="" required>
                  <option value="" disabled>
                    Choose a workload
                  </option>
                  {Object.entries(WORKLOAD_LABEL).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Scope
                <select name="scope" defaultValue="" required>
                  <option value="" disabled>
                    Choose a scope
                  </option>
                  <option value="organization">
                    Organization · search, answers or agent evidence
                  </option>
                  <option value="source">One source · document indexing</option>
                  <option value="connection">One connection · document indexing</option>
                </select>
              </label>
              <label>
                Source reference
                <input name="sourceId" maxLength={36} />
                <small>Required only for source scope. Leave the connection reference blank.</small>
              </label>
              <label>
                Connection reference
                <input name="connectionId" maxLength={36} />
                <small>Required only for connection scope. Leave the source reference blank.</small>
              </label>
              <fieldset className="group">
                <legend>Permitted purposes</legend>
                <div className="option-grid">
                  {Object.entries(PURPOSE_LABEL).map(([value, label]) => (
                    <label key={value} className="check">
                      <input type="checkbox" name="purposes" value={value} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="group">
                <legend>Exact capability evidence</legend>
                <div className="choice-list">
                  {usable.map((q) => (
                    <label key={q.id} className="choice">
                      <input type="checkbox" name="qualificationIds" value={q.id} />
                      <strong>
                        {q.profileAlias} · version {q.profileVersion} · {q.purpose} · {q.protocol}
                        {q.dimension === null
                          ? ''
                          : ` · ${q.dimension} dimensions / ${q.vectorSpaceVersion}`}
                      </strong>
                      <small className="technical-reference">{q.id}</small>
                    </label>
                  ))}
                </div>
                <p className="muted">
                  Select evidence for every permitted purpose. A later profile change makes that
                  evidence unavailable; it never moves this approval to another model.
                </p>
              </fieldset>
              <label>
                Highest permitted classification
                <select name="maxClassification" required defaultValue="">
                  <option value="" disabled>
                    Choose a classification
                  </option>
                  {['public', 'internal', 'confidential', 'restricted'].map((v) => (
                    <option key={v} value={v}>
                      {v.charAt(0).toUpperCase() + v.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <ModelBoundsFields />
              <label>
                Expiry, including timezone
                <input
                  name="expiresAt"
                  required
                  maxLength={40}
                  placeholder="YYYY-MM-DDTHH:mm:ssZ"
                />
                <small>
                  A date and time with its time zone, such as 2027-01-31T17:00:00+01:00, or with Z
                  on the end for UTC. No expiry is chosen for you.
                </small>
              </label>
              <div>
                <SubmitButton>Approve workload</SubmitButton>
              </div>
            </form>
          )}
          {qualifications.nextCursor && (
            <p className="link-line">
              <Link
                href={`?qualification_after=${qualifications.nextCursor}#approve-workload-heading`}
              >
                More capability choices
              </Link>
            </p>
          )}
        </section>
      </div>
    </>
  );
}
