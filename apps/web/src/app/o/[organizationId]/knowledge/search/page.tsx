import { KnowledgeForm } from '@/components/knowledge-form';
import { PageHead } from '@/components/ui';
import { searchKnowledgeAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Find a passage | Ensemus' };
export default async function KnowledgeSearchPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  await requireTenant(organizationId);
  return (
    <>
      <PageHead
        title="Find a source passage"
        description="Look up words in the documents you can read and see the exact passages that use them. Nothing you type here is sent to an AI model."
      />
      <KnowledgeForm
        action={searchKnowledgeAction}
        hidden={{ organizationId }}
        submit="Find passages"
        className="card inline-form knowledge-search-form"
        fields={[
          {
            name: 'query',
            kind: 'text',
            label: 'Words to look for',
            required: true,
            maxLength: 4000,
            placeholder: 'For example: notice period',
          },
        ]}
      />
    </>
  );
}
