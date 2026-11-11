import { listDirectory } from '@ensemus/application';
import { getFact } from '@ensemus/application/knowledge/facts';
import { can } from '@ensemus/domain/policy';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KnowledgeCitation } from '@/components/knowledge-view';
import {
  PageHead,
  StatusBadge,
  ClassificationBadge,
  BackLink,
  formatDateTime,
} from '@/components/ui';
import { reviewKnowledgeFactAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Fact review | Ensemus' };
const CATEGORY: Record<string, string> = {
  summary: 'Summary',
  deadline: 'Deadline',
  contact: 'Contact',
  requirement: 'Requirement',
  status: 'Status',
};
export default async function FactPage({
  params,
}: {
  params: Promise<{ organizationId: string; factId: string }>;
}) {
  const { organizationId, factId } = await params,
    { context, database } = await requireTenant(organizationId),
    fact = await orNotFound(getFact(database, context, factId));
  const reviewer = fact.reviewedByMembershipId
    ? (await listDirectory(database, context)).find(
        (person) => person.membershipId === fact.reviewedByMembershipId,
      )?.name
    : undefined;
  return (
    <>
      <div>
        <BackLink href={`/o/${organizationId}/knowledge/facts`}>Back to facts</BackLink>
        <PageHead title="Source-backed fact" />
      </div>
      <div className="detail-layout">
        <div className="stack">
          <section className="card" aria-labelledby="claim-heading">
            <h2 id="claim-heading">The fact</h2>
            <p className="pre-wrap fact-claim">
              {typeof fact.claim === 'string' ? fact.claim : JSON.stringify(fact.claim, null, 2)}
            </p>
          </section>
          {fact.conflictRef && (
            <p className="notice warn">
              This fact disagrees with a record or document that takes priority, so it is not
              treated as trusted.
            </p>
          )}
          <section className="stack" aria-labelledby="passages-heading">
            <div className="section-intro">
              <h2 id="passages-heading">Supporting passages</h2>
              <p>The words in your documents this fact rests on.</p>
            </div>
            {fact.evidence.map((e) => (
              <KnowledgeCitation
                key={e.chunkId}
                organizationId={organizationId}
                citation={{ ...e, freshness: e.stale ? 'superseded' : 'current' }}
              />
            ))}
          </section>
          {['proposed', 'disputed'].includes(fact.trustState) &&
            can(context.role, 'knowledge.review_fact') && (
              <section className="stack" aria-labelledby="review-heading">
                <div className="section-intro">
                  <h2 id="review-heading">Review the claim</h2>
                  <p>
                    Read the passages above first. Someone other than the person who proposed it has
                    to check it.
                  </p>
                </div>
                <KnowledgeForm
                  action={reviewKnowledgeFactAction}
                  hidden={{ organizationId, factId, version: String(fact.version) }}
                  submit="Save review"
                  fields={[
                    {
                      name: 'decision',
                      kind: 'select',
                      label: 'Decision',
                      required: true,
                      options: [
                        { value: '', label: 'Choose a decision' },
                        { value: 'verify', label: 'Verify this claim' },
                        { value: 'reject', label: 'Reject this claim' },
                      ],
                    },
                    {
                      name: 'reason',
                      kind: 'textarea',
                      label: 'Reason',
                      required: true,
                      maxLength: 2000,
                      rows: 3,
                    },
                  ]}
                />
              </section>
            )}
        </div>
        <aside className="card">
          <dl className="details">
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={fact.trustState} />
              </dd>
            </div>
            <div>
              <dt>Who can see this</dt>
              <dd>
                <ClassificationBadge value={fact.classification} />
              </dd>
            </div>
            <div>
              <dt>Kind of fact</dt>
              <dd>{CATEGORY[fact.predicate] ?? fact.predicate}</dd>
            </div>
            <div>
              <dt>Proposed by</dt>
              <dd>{fact.origin === 'model' ? 'An assistant' : 'A person'}</dd>
            </div>
            {fact.reviewedAt && (
              <div>
                <dt>Checked by</dt>
                <dd>
                  {reviewer ?? 'A former member'}, {formatDateTime(fact.reviewedAt)}
                </dd>
              </div>
            )}
          </dl>
          <details className="gap-above-large">
            <summary>Technical details</summary>
            <p className="technical-reference">Subject reference: {fact.subjectRef}</p>
          </details>
        </aside>
      </div>
    </>
  );
}
