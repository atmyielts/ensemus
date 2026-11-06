import type { ReactNode } from 'react';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { SectionNavigation } from '@/components/section-navigation';
import { requireTenant } from '@/server/tenant';
export default async function KnowledgeLayout({
  params,
  children,
}: {
  params: Promise<{ organizationId: string }>;
  children: ReactNode;
}) {
  const { organizationId } = await params;
  await requireTenant(organizationId);
  const base = `/o/${organizationId}/knowledge`;
  return (
    <OneActionAtATime>
      <div className="stack">
        <SectionNavigation
          label="Knowledge"
          items={[
            {
              href: base,
              label: 'Sources',
              exact: true,
              matches: [`${base}/sources`, `${base}/new`],
            },
            { href: `${base}/search`, label: 'Find a passage' },
            { href: `${base}/ask`, label: 'Ask a question' },
            { href: `${base}/answers`, label: 'My answers' },
            { href: `${base}/facts`, label: 'Facts' },
            { href: `${base}/graph`, label: 'Related records' },
          ]}
        />
        {children}
      </div>
    </OneActionAtATime>
  );
}
