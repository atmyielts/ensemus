import { listDirectory } from '@ensemus/application';
import { getFact } from '@ensemus/application/knowledge/facts';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KnowledgeCitation } from '@/components/knowledge-view';
import { PageHead, StatusBadge, ClassificationBadge, formatDateTime } from '@/components/ui';
import { reviewKnowledgeFactAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Fact review | Ensemus' };
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
      <Link href={`/o/${organizationId}/knowledge/facts`}>Back to facts</Link>
      <PageHead title="Source-backed fact" />
      <div className="row">
        <StatusBadge status={fact.trustState} />
        <ClassificationBadge value={fact.classification} />
      </div>
      <p className="pre-wrap">
        {typeof fact.claim === 'string' ? fact.claim : JSON.stringify(fact.claim, null, 2)}
      </p>
      <p className="muted">
        {fact.origin === 'model' ? 'Proposed by an assistant' : 'Proposed by a person'}. Category:{' '}
        {fact.predicate}
      </p>
      {fact.conflictRef && (
        <p className="notice">
          This claim conflicts with an authoritative record or source state. It is not trusted as a
          verified fact.
        </p>
      )}
      {fact.reviewedAt && (
        <p className="muted">
          Reviewed by {reviewer ?? 'a former member'} · {formatDateTime(fact.reviewedAt)}
        </p>
      )}
      <section className="stack">
        <h2>Supporting passages</h2>
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
          <section className="stack">
            <h2>Review the claim</h2>
            <KnowledgeForm
              action={reviewKnowledgeFactAction}
              hidden={{ organizationId, factId, version: String(fact.version) }}
              submit="Save review"
              description="Only a different person from the proposer can verify this claim. Review the actual passages before deciding."
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
                },
              ]}
            />
          </section>
        )}
      <details>
        <summary>Record details</summary>
        <p>Subject reference: {fact.subjectRef}</p>
      </details>
    </>
  );
}
