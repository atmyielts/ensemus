import { countUnread, listMyPendingApprovals } from '@ensemus/application';
import { getOrganization } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { DraftScope } from '@/components/kept-field';
import { MainNav, WorkspaceContext } from '@/components/main-nav';
import { workspaceNavigation } from '@/components/navigation-model';
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
  const navigation = workspaceNavigation({
    base,
    role: context.role,
    unread,
    pending: pending.length,
  });

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="sidebar-inner">
          <div className="workspace-brand">
            <Link className="brand" href={base}>
              <span className="brand-symbol" aria-hidden="true">
                E
              </span>
              Ensemus
            </Link>
            <div className="org-name" title={organization.name}>
              {organization.name}
            </div>
            {organizations.length > 1 && (
              <Link className="workspace-switch" href="/">
                Switch organization <span aria-hidden="true">↗</span>
              </Link>
            )}
          </div>
          <div className="desktop-navigation">
            <MainNav groups={navigation} />
          </div>
          <details className="mobile-navigation">
            <summary>
              Workspace menu <span aria-hidden="true">⌄</span>
            </summary>
            <MainNav groups={navigation} label="Mobile main" />
          </details>
          <div className="sidebar-end">
            <span className="account-avatar" aria-hidden="true">
              {Array.from(actor.name)[0]?.toUpperCase() ?? 'E'}
            </span>
            <div className="account-details">
              <Link className="account-name" href={`${base}/security`} title="Your account security">
                {actor.name}
              </Link>
              <span className="account-email">{actor.email}</span>
            </div>
            <form action={signOutAction}>
              <SubmitButton className="link" working="Signing out">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </div>
      </aside>
      <main id="main" className="content" tabIndex={-1}>
        <WorkspaceContext groups={navigation} organizationName={organization.name} base={base} />
        <DraftScope account={actor.userId}>{children}</DraftScope>
      </main>
    </div>
  );
}
