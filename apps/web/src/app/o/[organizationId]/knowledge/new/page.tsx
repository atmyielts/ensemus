import { randomUUID } from 'node:crypto';
import { listDirectory } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KNOWLEDGE_CLASSES } from '@/components/knowledge-view';
import { PageHead, Empty } from '@/components/ui';
import { uploadKnowledgeAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Add a source | Ensemus' };
export default async function NewSourcePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'knowledge.add'))
    return (
      <>
        <PageHead title="Add a source" />
        <Empty>Your role cannot add company sources. Ask an organization administrator.</Empty>
      </>
    );
  const people = await listDirectory(database, context);
  return (
    <>
      <Link href={`/o/${organizationId}/knowledge`}>Back to sources</Link>
      <PageHead
        title="Add a source"
        description="Add a text document. Processing happens in the background after the file is saved."
      />
      <KnowledgeForm
        action={uploadKnowledgeAction}
        hidden={{ organizationId, requestKey: randomUUID() }}
        submit="Add source"
        fields={[
          { name: 'title', label: 'Source name', required: true, maxLength: 512 },
          {
            name: 'classification',
            kind: 'select',
            label: 'Sensitivity',
            required: true,
            value: 'restricted',
            options: KNOWLEDGE_CLASSES,
            help: 'Choose the strongest sensitivity in the document. Restricted sources can be shared only with named people.',
          },
          {
            name: 'sharing',
            kind: 'select',
            label: 'Share with',
            value: '',
            options: [
              { value: '', label: 'Only me' },
              {
                value: 'organization',
                label: 'Everyone in this organization (Public or Internal only)',
              },
              ...people
                .filter((p) => p.status === 'active' && p.membershipId !== context.membershipId)
                .map((p) => ({ value: p.membershipId, label: p.name })),
            ],
            help: 'You remain a named reader. More access can be added later.',
          },
          {
            name: 'file',
            kind: 'file',
            label: 'Document',
            required: true,
            help: 'Text, Markdown, CSV, HTML or JSON. Up to 25 MB. Choose the file again if a save is refused.',
          },
        ]}
      />
    </>
  );
}
