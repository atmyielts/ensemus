import { randomUUID } from 'node:crypto';
import { KnowledgeForm } from '@/components/knowledge-form';
import { questionLevelChoices } from '@/components/knowledge-view';
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
        description="Ask in your own words. The answer is written from the documents you can read, and shows you the passages it used."
      />
      <KnowledgeForm
        action={askKnowledgeAction}
        hidden={{ organizationId, requestKey: randomUUID() }}
        submit="Ask question"
        className="card fields ask-form"
        description="Your question stays private to you, and it only goes to an AI model your company has approved for its level of privacy."
        fields={[
          {
            name: 'question',
            kind: 'textarea',
            label: 'Your question',
            required: true,
            maxLength: 4000,
            rows: 4,
            placeholder: 'For example: What is our notice period for ending a supplier contract?',
          },
          {
            name: 'classification',
            kind: 'choices',
            label: 'How private is your question?',
            required: true,
            value: 'restricted',
            options: questionLevelChoices(),
            help: 'Pick the level of the most private detail you mention. If no AI model is approved for that level, your question is not sent anywhere.',
          },
        ]}
      />
    </>
  );
}
