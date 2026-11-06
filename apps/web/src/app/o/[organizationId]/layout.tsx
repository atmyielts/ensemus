import { countUnread, listMyPendingApprovals } from '@ensemus/application';
import { getOrganization } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { MainNav } from '@/components/main-nav';
import { SubmitButton } from '@/components/submit-button';
import { signOutAction } from '@/server/actions';
import { organizationsWithAccess } from '@/server/organizations';
import { requireTenant } from '@/server/tenant';

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { actor, context, database } = await requireTenant(organizationId);
  const [organization, unread, pending, organizations] = await Promise.all([
    getOrganization(database, context),
    countUnread(database, context),
    listMyPendingApprovals(database, context),
    organizationsWithAccess(actor.userId),
  ]);
  if (!organization) notFound();
  const base = `/o/${organizationId}`;

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="sidebar-inner">
          <div>
            <Link className="brand" href={base}>
              Ensemus
            </Link>
            <div className="org-name">{organization.name}</div>
          </div>
          <MainNav
            items={[
              { href: base, label: 'Home', exact: true },
              { href: `${base}/work`, label: 'Work' },
              { href: `${base}/approvals`, label: 'Approvals', count: pending.length },
              { href: `${base}/people`, label: 'People and teams' },
              { href: `${base}/clients`, label: 'Clients and projects' },
              { href: `${base}/inbox`, label: 'Inbox', count: unread },
            ]}
          />
          <div className="sidebar-end">
            {organizations.length > 1 && <Link href="/">Switch organization</Link>}
            <span className="account-name">{actor.name}</span>
            <span className="account-email">{actor.email}</span>
            <form action={signOutAction}>
              <SubmitButton className="link" working="Signing out">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </div>
      </aside>
      <main id="main" className="content">
        {children}
      </main>
    </div>
  );
}
