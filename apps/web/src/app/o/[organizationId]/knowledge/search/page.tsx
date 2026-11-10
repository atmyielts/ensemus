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
        description="Search the current documents you can read. This search sends nothing to a model."
      />
      <KnowledgeForm
        action={searchKnowledgeAction}
        hidden={{ organizationId }}
        submit="Find passages"
        fields={[
          {
            name: 'query',
            kind: 'textarea',
            label: 'Words to look for',
            required: true,
            maxLength: 4000,
          },
        ]}
      />
    </>
  );
}
