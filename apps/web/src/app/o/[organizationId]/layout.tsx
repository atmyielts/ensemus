import { countUnread, listMyPendingApprovals } from '@ensemus/application';
import { getOrganization } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { signOutAction } from '@/server/actions';
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
  const [organization, unread, pending] = await Promise.all([
    getOrganization(database, context),
    countUnread(database, context),
    listMyPendingApprovals(database, context),
  ]);
  if (!organization) notFound();
  const base = `/o/${organizationId}`;

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div>
          <Link className="brand" href={base}>
            Ensemus
          </Link>
          <div className="org-name">{organization.name}</div>
        </div>
        <nav className="nav" aria-label="Main">
          <Link href={base}>Home</Link>
          <Link href={`${base}/work`}>Work</Link>
          <Link href={`${base}/approvals`}>
            Approvals {pending.length > 0 && <span className="count">{pending.length}</span>}
          </Link>
          <Link href={`${base}/people`}>People and teams</Link>
          <Link href={`${base}/clients`}>Clients and projects</Link>
          <Link href={`${base}/inbox`}>
            Inbox {unread > 0 && <span className="count">{unread}</span>}
          </Link>
        </nav>
        <div className="sidebar-end">
          <Link href="/">Switch organization</Link>
          <span className="muted">{actor.email}</span>
          <form action={signOutAction}>
            <button className="link" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="main" className="content">
        {children}
      </main>
    </div>
  );
}
