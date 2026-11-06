import { randomUUID } from 'node:crypto';
import { KnowledgeForm } from '@/components/knowledge-form';
import { KNOWLEDGE_CLASSES } from '@/components/knowledge-view';
import { PageHead } from '@/components/ui';
import { askKnowledgeAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Ask company knowledge | Ensemus' };
export default async function AskPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  await requireTenant(organizationId);
  return (
    <>
      <PageHead
        title="Ask company knowledge"
        description="An approved model can answer using sources you can read. You will see the passages it used."
      />
      <KnowledgeForm
        action={askKnowledgeAction}
        hidden={{ organizationId, requestKey: randomUUID() }}
        submit="Ask question"
        description="Your question is private to you. Its sensitivity applies even when no source is found. If policy permits no model, the question is refused without sending it to a provider."
        fields={[
          {
            name: 'question',
            kind: 'textarea',
            label: 'Your question',
            required: true,
            maxLength: 4000,
          },
          {
            name: 'classification',
            kind: 'select',
            label: 'Question sensitivity',
            required: true,
            value: 'restricted',
            options: KNOWLEDGE_CLASSES,
            help: 'Include the sensitivity of any names, numbers or context in the question itself.',
          },
        ]}
      />
    </>
  );
}
