import { listMcpTools } from '@ensemus/application/knowledge/mcp';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { KnowledgeForm } from '@/components/knowledge-form';
import { BackLink, Empty, PageHead, StatusBadge } from '@/components/ui';
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
      <BackLink href={`/o/${p.organizationId}/settings/connections`}>Back to connections</BackLink>
      <PageHead
        title="Review connection tools"
        description="Each tool this connection offers waits for your review before an assistant can use it. Its own description comes from the other system and is not trusted, so you decide what it may do and which information it may see."
      />
      <div className="stack">
        {!tools.length ? (
          <Empty title="No tools found yet">
            Sync this connection to ask it for its current list of tools, and they appear here for
            review.
          </Empty>
        ) : (
          tools.map((tool) => (
            <section className="card stack" key={tool.id}>
              <div className="spread">
                <h2>{tool.toolName}</h2>
                <StatusBadge status={tool.status} />
              </div>
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
                      help: 'Restricted information never goes through this connection.',
                    },
                  ]}
                />
              )}
              <details>
                <summary>Technical details</summary>
                <pre>{JSON.stringify(tool.definition, null, 2)}</pre>
                <p className="technical-reference gap-above-small">{tool.definitionSha256}</p>
              </details>
            </section>
          ))
        )}
      </div>
    </OneActionAtATime>
  );
}
