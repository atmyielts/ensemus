import { OrganizationSwitcher } from '@/components/organization-switcher';
import { countUnread, listMyPendingApprovals } from '@ensemus/application';
import { getOrganization } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { DraftScope } from '@/components/kept-field';
import { MainNav, NavigationPendingRegion, WorkspaceContext } from '@/components/main-nav';
import { workspaceNavigation } from '@/components/navigation-model';
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
  const navigation = workspaceNavigation({
    base,
    role: context.role,
    unread,
    pending: pending.length,
  });

  return (
    <SidebarProvider className="block">
      <div className="shell">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <aside className="sidebar">
          <div className="sidebar-inner">
            <div className="workspace-brand">
              <Link className="brand" href={base}>
                <span className="brand-mark" aria-hidden="true">
                  en
                </span>
                <span>ensemus</span>
              </Link>
              <div className="org-name" title={organization.name}>
                {organization.name}
              </div>
              {organizations.length > 1 && (
                <OrganizationSwitcher
                  current={organizationId}
                  organizations={organizations.map(({ id, name }) => ({ id, name }))}
                />
              )}
            </div>
            <NavigationPendingRegion>
              <div className="desktop-navigation">
                <MainNav groups={navigation} />
              </div>
              <details className="mobile-navigation">
                <summary>
                  Workspace menu <span aria-hidden="true">⌄</span>
                </summary>
                <MainNav groups={navigation} label="Mobile main" />
              </details>
            </NavigationPendingRegion>
            <div className="sidebar-end">
              <Avatar className="account-avatar size-9 rounded-md">
                <AvatarFallback className="rounded-md font-mono text-xs">
                  {Array.from(actor.name)[0]?.toUpperCase() ?? 'E'}
                </AvatarFallback>
              </Avatar>
              <div className="account-details">
                <Link
                  className="account-name"
                  href={`${base}/security`}
                  title="Your account security"
                >
                  {actor.name}
                </Link>
                <span className="account-email" title={actor.email}>
                  {actor.email}
                </span>
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
    </SidebarProvider>
  );
}
