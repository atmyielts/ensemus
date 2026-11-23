import { BrandIdentity } from '@/components/brand-identity';
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
import { MobileWorkspaceMenu } from '@/components/mobile-workspace-menu';
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
  const workspaceSwitcher = organizations.length > 1 && (
    <OrganizationSwitcher
      current={organizationId}
      organizations={organizations.map(({ id, name }) => ({ id, name }))}
    />
  );
  const account = (
    <div className="sidebar-end">
      <Avatar className="account-avatar size-9 rounded-md">
        <AvatarFallback className="rounded-md font-mono text-xs">
          {Array.from(actor.name)[0]?.toUpperCase() ?? 'E'}
        </AvatarFallback>
      </Avatar>
      <div className="account-details">
        <Link className="account-name" href={`${base}/security`} title="Your account security">
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
  );

  return (
    <SidebarProvider className="block">
      <NavigationPendingRegion>
        <div className="shell">
          <a className="skip" href="#main">
            Skip to content
          </a>
          <aside className="sidebar">
            <div className="sidebar-inner">
              <div className="workspace-brand">
                <Link className="brand" href={base}>
                  <BrandIdentity />
                </Link>
                <div className="org-name" title={organization.name}>
                  {organization.name}
                </div>
                {workspaceSwitcher}
              </div>
              <div className="desktop-navigation">
                <MainNav groups={navigation} />
              </div>
              {account}
            </div>
          </aside>
          <div className="content">
            <WorkspaceContext
              groups={navigation}
              organizationName={organization.name}
              base={base}
              mobileMenu={
                <MobileWorkspaceMenu>
                  <div className="mobile-navigation-brand">
                    <Link className="brand" href={base}>
                      <BrandIdentity />
                    </Link>
                    {workspaceSwitcher}
                  </div>
                  <MainNav groups={navigation} label="Mobile main" />
                  {account}
                </MobileWorkspaceMenu>
              }
            />
            <main id="main" tabIndex={-1}>
              <DraftScope account={actor.userId}>{children}</DraftScope>
            </main>
          </div>
        </div>
      </NavigationPendingRegion>
    </SidebarProvider>
  );
}
