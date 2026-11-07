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
import { ClassificationBadge, Empty, ErrorNotice, formatDate, PageHead } from '@/components/ui';
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
      <PageHead
        title="Knowledge workload approvals"
        description="Give a specific Knowledge workload bounded, expiring permission to use qualified models."
        actions={<Link href={`/o/${organizationId}/settings/models`}>All models</Link>}
      />
      <ErrorNotice code={query.error} />
      <p className="notice" role="status">
        Without a usable approval, search remains lexical and paid generation is refused. An
        approval is a ceiling, not a promise to spend: live access, model policy, organization
        budget and provider availability are checked for every call.
      </p>
      <div className="stack">
        <section className="card" aria-labelledby="workload-history-heading">
          <h2 id="workload-history-heading">Recorded approvals</h2>
          {!approvals.items.length ? (
            <Empty>No workload approvals on this page.</Empty>
          ) : (
            <ul className="list">
              {approvals.items.map((approval) => (
                <li key={approval.id}>
                  <div className="stack">
                    <strong>{WORKLOAD_LABEL[approval.kind] ?? approval.kind}</strong>
                    <span className="badge">{workloadState(approval)}</span>
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
            <Link href={`?after=${approvals.nextCursor}#workload-history-heading`}>
              More approvals
            </Link>
          )}
        </section>
        <section className="card" aria-labelledby="approve-workload-heading">
          <h2 id="approve-workload-heading">Approve a bounded workload</h2>
          <p className="muted">
            Only current, passed capability evidence can be selected. Approval requires native
            sign-in, the organization’s SSO policy and fresh second-factor verification. Revocation
            remains available without a new second-factor check.
          </p>
          {!usable.length ? (
            <Empty
              action={<Link href={`/o/${organizationId}/settings/models`}>Qualify a model</Link>}
            >
              No usable capability evidence on this page.
            </Empty>
          ) : (
            <form className="fields" action={approveWorkloadAction}>
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
              <fieldset>
                <legend>Permitted purposes</legend>
                <div className="choices">
                  {Object.entries(PURPOSE_LABEL).map(([value, label]) => (
                    <label key={value}>
                      <input type="checkbox" name="purposes" value={value} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Exact capability evidence</legend>
                <div className="choices">
                  {usable.map((q) => (
                    <label key={q.id}>
                      <input type="checkbox" name="qualificationIds" value={q.id} />
                      {q.profileAlias} · version {q.profileVersion} · {q.purpose} · {q.protocol}
                      {q.dimension === null
                        ? ''
                        : ` · ${q.dimension} dimensions / ${q.vectorSpaceVersion}`}
                      <small>{q.id}</small>
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
                      {v}
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
                  Enter an explicit ISO date and time with Z for UTC or a timezone offset. No expiry
                  is chosen for you.
                </small>
              </label>
              <div>
                <SubmitButton className="quiet">Approve workload</SubmitButton>
              </div>
            </form>
          )}
          {qualifications.nextCursor && (
            <Link
              href={`?qualification_after=${qualifications.nextCursor}#approve-workload-heading`}
            >
              More capability choices
            </Link>
          )}
        </section>
      </div>
    </>
  );
}
