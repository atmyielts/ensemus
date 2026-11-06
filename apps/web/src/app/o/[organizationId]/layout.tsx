import { countUnread, listMyPendingApprovals } from '@ensemus/application';
import { getOrganization } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { DraftScope } from '@/components/kept-field';
import { MainNav } from '@/components/main-nav';
import { SubmitButton } from '@/components/submit-button';
import { signOutAction } from '@/server/actions';
import { organizationsWithAccess } from '@/server/organizations';
import { requireAccountTenant } from '@/server/tenant';

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  // Around the account pages too, which a suspended tenant keeps, so the pages inside make the core check.
  const { actor, context, database } = await requireAccountTenant(organizationId);
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
              { href: `${base}/account`, label: 'Account' },
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
        <DraftScope account={actor.userId}>{children}</DraftScope>
      </main>
    </div>
  );
}
