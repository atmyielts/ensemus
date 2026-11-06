import Link from 'next/link';
import type { ReactNode } from 'react';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
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
        <nav className="row" aria-label="Knowledge">
          <Link href={base}>Sources</Link>
          <Link href={`${base}/search`}>Find a passage</Link>
          <Link href={`${base}/ask`}>Ask a question</Link>
          <Link href={`${base}/answers`}>My answers</Link>
          <Link href={`${base}/facts`}>Facts</Link>
          <Link href={`${base}/graph`}>Related records</Link>
        </nav>
        {children}
      </div>
    </OneActionAtATime>
  );
}
