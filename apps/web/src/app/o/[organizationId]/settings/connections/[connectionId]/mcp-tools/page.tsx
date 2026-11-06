import { listMcpTools } from '@ensemus/application/knowledge/mcp';
import Link from 'next/link';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { KnowledgeForm } from '@/components/knowledge-form';
import { PageHead, Empty, StatusBadge } from '@/components/ui';
import { reviewKnowledgeMcpAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Review connection tools | Ensemus' };
export default async function ToolsPage({
  params,
}: {
  params: Promise<{ organizationId: string; connectionId: string }>;
}) {
  const p = await params,
    { context, database } = await requireTenant(p.organizationId),
    tools = await orNotFound(listMcpTools(database, context, p));
  return (
    <OneActionAtATime>
      <div className="stack">
        <Link href={`/o/${p.organizationId}/settings/connections`}>Back to connections</Link>
        <PageHead
          title="Review connection tools"
          description="Server-provided descriptions and annotations are untrusted. Choose the effect and allowed sensitivity yourself."
        />
        {!tools.length ? (
          <Empty>
            No tools have been discovered for this connection. Sync it to request the current tool
            list.
          </Empty>
        ) : (
          tools.map((tool) => (
            <section className="card stack" key={tool.id}>
              <h2>{tool.toolName}</h2>
              <div>
                <StatusBadge status={tool.status} />
              </div>
              <details>
                <summary>Tool definition and digest</summary>
                <pre>{JSON.stringify(tool.definition, null, 2)}</pre>
                <p>{tool.definitionSha256}</p>
              </details>
              {tool.status !== 'removed' && (
                <KnowledgeForm
                  action={reviewKnowledgeMcpAction}
                  hidden={{ ...p, toolId: tool.id, version: String(tool.version) }}
                  submit="Save tool review"
                  fields={[
                    {
                      name: 'decision',
                      kind: 'select',
                      label: 'Decision',
                      required: true,
                      options: [
                        { value: '', label: 'Choose a decision' },
                        { value: 'approve', label: 'Approve with my limits' },
                        { value: 'reject', label: 'Reject this tool' },
                      ],
                    },
                    {
                      name: 'sideEffectLevel',
                      kind: 'select',
                      label: 'What may this tool do?',
                      options: [
                        { value: '', label: 'Choose when approving' },
                        { value: 'read_only', label: 'Read information only' },
                        {
                          value: 'external_write',
                          label: 'Change an external system (separate action approval required)',
                        },
                      ],
                    },
                    {
                      name: 'allowedClasses',
                      kind: 'select',
                      label: 'Allowed data sensitivity',
                      options: [
                        { value: '', label: 'Choose when approving' },
                        { value: 'public', label: 'Public only' },
                        { value: 'internal', label: 'Internal only' },
                        { value: 'confidential', label: 'Confidential only' },
                      ],
                      help: 'Restricted data is never permitted through this connection.',
                    },
                  ]}
                />
              )}
            </section>
          ))
        )}
      </div>
    </OneActionAtATime>
  );
}
