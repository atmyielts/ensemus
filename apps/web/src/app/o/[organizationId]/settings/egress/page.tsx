import { AppError } from '@ensemus/application';
import { listEgressLedger } from '@ensemus/application/knowledge/egress';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KNOWLEDGE_CLASSES } from '@/components/knowledge-view';
import {
  BackLink,
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatDateTime,
  PageHead,
} from '@/components/ui';
import { simulateKnowledgeEgressAction } from '@/server/knowledge-actions';
import { getKnowledgeReadPorts } from '@/server/knowledge-ports';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Model data sharing | Ensemus' };
export default async function EgressPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'egress.view'))
    return (
      <>
        <PageHead title="Model data sharing" />
        <Empty>
          Your role cannot inspect model data-sharing policy. Ask an organization administrator.
        </Empty>
      </>
    );
  const { cursor } = await searchParams,
    ports = await getKnowledgeReadPorts(database, context);
  let error: string | undefined;
  const page = await listEgressLedger(database, context, ports, {
    ...(cursor ? { after: cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    error = 'INVALID_INPUT';
    return listEgressLedger(database, context, ports, {});
  });
  return (
    <>
      <BackLink href={`/o/${organizationId}/settings`}>Back to administration</BackLink>
      <PageHead
        title="Model data sharing"
        description="Each time company information was sent to an AI model, or held back, and why. You can also check a proposed AI model arrangement without sending anything."
      />
      <ErrorNotice code={error} />
      {ports.coverage !== 'complete' && (
        <p className="notice">
          This record covers knowledge (search and answers) only for now. Assistant runs are not
          included yet, so a comparison cannot confirm what would be sent for them.
        </p>
      )}
      <section className="card stack" aria-labelledby="decisions-heading">
        <div className="spread">
          <h2 id="decisions-heading">Recorded decisions</h2>
          <a
            className="button secondary"
            href={
              '/api/v1/organizations/' +
              organizationId +
              '/egress-ledger' +
              (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')
            }
            download="model-sharing-decisions.json"
          >
            Download these decisions as JSON
          </a>
        </div>
        {!page.items.length ? (
          <Empty title="Nothing recorded yet">
            When company information is sent to an AI model, or held back, the decision is recorded
            here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Model transmission decisions</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Who can see it</th>
                  <th scope="col">Sent to</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.occurredAt)}</td>
                    <td>
                      {(
                        {
                          embed: 'Search indexing',
                          rerank: 'Passage ranking',
                          answer: 'Answer',
                          agent_run: 'Assistant run',
                        } as Record<string, string>
                      )[row.purpose] ?? row.purpose}
                    </td>
                    <td>
                      <ClassificationBadge value={row.dataClass} />
                    </td>
                    <td>{row.destinationHost ?? 'No destination selected'}</td>
                    <td>
                      {row.decision === 'allow' ? 'Allowed' : 'Refused'}
                      <details>
                        <summary>Technical details</summary>
                        <p>
                          {row.reasonCode} · Policy {row.policyVersion}
                        </p>
                        {row.requestSha256 && <p>Request digest: {row.requestSha256}</p>}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.next && (
          <p className="link-line">
            <Link href={`?cursor=${encodeURIComponent(page.next)}`}>Earlier decisions</Link>
          </p>
        )}
      </section>
      <details className="card gap-above-large">
        <summary>Compare a proposed provider</summary>
        <KnowledgeForm
          action={simulateKnowledgeEgressAction}
          hidden={{ organizationId }}
          submit="Compare proposal"
          description="Compare data-sharing policy for this proposal. This sends no company text and changes no settings. A compatible result still needs an approved model, budget and permitted connection before a real call can run."
          fields={[
            {
              name: 'destination',
              kind: 'select',
              label: 'Provider arrangement',
              required: true,
              options: [
                { value: 'customer_private_inference', label: 'Customer private inference' },
                { value: 'customer_byom_public_api', label: 'Customer API account' },
                { value: 'ensemus_cloud_managed_model', label: 'Ensemus-managed provider' },
              ],
            },
            {
              name: 'destinationHost',
              label: 'Provider hostname',
              required: true,
              maxLength: 253,
              help: 'Host only, without a URL path, token or credential.',
            },
            {
              name: 'billingOwner',
              kind: 'select',
              label: 'Who pays the provider?',
              required: true,
              options: [
                { value: 'customer', label: 'Customer' },
                { value: 'ensemus', label: 'Ensemus' },
              ],
            },
            {
              name: 'retentionBasis',
              kind: 'select',
              label: 'Retention arrangement',
              required: true,
              options: [
                { value: 'unreviewed', label: 'Not reviewed' },
                { value: 'contract_recorded', label: 'Contract recorded' },
                { value: 'self_hosted', label: 'Self-hosted' },
              ],
            },
            { name: 'region', label: 'Region', maxLength: 64 },
            { name: 'contractRef', label: 'Contract reference', maxLength: 128 },
            {
              name: 'purpose',
              kind: 'select',
              label: 'Approved use to compare',
              required: true,
              value: 'reason',
              options: [
                { value: 'classify', label: 'Classify information' },
                { value: 'extract', label: 'Extract information' },
                { value: 'reason', label: 'Reason over work' },
                { value: 'research', label: 'Research' },
                { value: 'compose', label: 'Write content' },
                { value: 'embed', label: 'Prepare semantic search' },
                { value: 'rerank', label: 'Rank search results' },
                { value: 'answer', label: 'Answer a question' },
              ],
            },
            {
              name: 'allowedClass',
              kind: 'select',
              label: 'Sensitivity to evaluate',
              required: true,
              value: 'restricted',
              options: KNOWLEDGE_CLASSES,
            },
          ]}
        />
      </details>
    </>
  );
}
