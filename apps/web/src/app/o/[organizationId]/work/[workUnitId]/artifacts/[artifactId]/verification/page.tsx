import { getArtifactVerification } from '@ensemus/application/knowledge/verification';
import Link from 'next/link';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { KnowledgeForm } from '@/components/knowledge-form';
import { PageHead, StatusBadge } from '@/components/ui';
import { decideKnowledgeArtifactAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Review deliverable | Ensemus' };
export default async function VerificationPage({
  params,
}: {
  params: Promise<{ organizationId: string; workUnitId: string; artifactId: string }>;
}) {
  const p = await params,
    { context, database } = await requireTenant(p.organizationId),
    proof = await orNotFound(getArtifactVerification(database, context, p));
  return (
    <OneActionAtATime>
      <div className="stack">
        <Link href={`/o/${p.organizationId}/work/${p.workUnitId}`}>
          Back to work and deliverables
        </Link>
        <PageHead
          title="Review this deliverable"
          description="Read the file in its work, check the supporting passages and compare it with the current objective."
        />
        <p className="notice">
          {proof.grounding?.verdict === 'passed'
            ? 'Structural citation checks passed. This does not prove the claims are true; a person must still review them.'
            : proof.grounding?.verdict === 'failed'
              ? 'Citation checks did not pass. This deliverable cannot be accepted until a new valid check is recorded.'
              : 'A background citation check has not been recorded. Acceptance is unavailable until it passes.'}
        </p>
        {proof.human && (
          <p>
            Latest human decision:{' '}
            <StatusBadge status={proof.human.verdict === 'accepted' ? 'approved' : 'rejected'} />
          </p>
        )}
        <section className="stack">
          <h2>Supporting passages</h2>
          {!proof.citations.length ? (
            <p>No supporting passages are recorded.</p>
          ) : (
            proof.citations.map((citation) => (
              <article key={citation.ordinal} className="card">
                <h3>
                  {citation.available ? (
                    <Link href={`/o/${p.organizationId}/knowledge/sources/${citation.sourceId}`}>
                      {citation.title ?? 'Source passage'}
                    </Link>
                  ) : (
                    'Source unavailable'
                  )}
                </h3>
                <p className="pre-wrap">
                  {citation.available
                    ? citation.excerpt
                    : 'This passage is no longer available to you. It cannot support acceptance.'}
                </p>
              </article>
            ))
          )}
        </section>
        <KnowledgeForm
          action={decideKnowledgeArtifactAction}
          hidden={{
            organizationId: p.organizationId,
            workUnitId: p.workUnitId,
            artifactId: p.artifactId,
            artifactSha256: proof.artifactSha256,
            objectiveSha256: proof.objectiveSha256,
            citationsSha256: proof.citationsSha256,
          }}
          submit="Record my decision"
          fields={[
            {
              name: 'verdict',
              kind: 'select',
              label: 'Decision',
              required: true,
              options: [
                { value: '', label: 'Choose a decision' },
                ...(proof.grounding?.verdict === 'passed' &&
                proof.citations.every((c) => c.available)
                  ? [{ value: 'accepted', label: 'Accept this exact deliverable' }]
                  : []),
                { value: 'rejected', label: 'Reject this deliverable' },
              ],
            },
            {
              name: 'reason',
              kind: 'textarea',
              label: 'Review note',
              maxLength: 2000,
              help: 'A reason is required when rejecting a deliverable.',
            },
          ]}
        />
        <details>
          <summary>Exact review identifiers</summary>
          <dl className="facts">
            <dt>File digest</dt>
            <dd>{proof.artifactSha256}</dd>
            <dt>Objective digest</dt>
            <dd>{proof.objectiveSha256}</dd>
            <dt>Citation digest</dt>
            <dd>{proof.citationsSha256}</dd>
          </dl>
        </details>
      </div>
    </OneActionAtATime>
  );
}
