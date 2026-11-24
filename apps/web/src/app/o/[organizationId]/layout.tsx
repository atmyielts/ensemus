import { BrandIdentity, BrandMark } from '@/components/brand-identity';
import { OrganizationSwitcher } from '@/components/organization-switcher';
import { countUnread, listMyPendingApprovals } from '@ensemus/application';
import { getOrganization, hasOtherAccessibleOrganization } from '@ensemus/database';
import { LogOutIcon } from 'lucide-react';
import Link from 'next/link';
import type { Viewport } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { SIDEBAR_COOKIE_NAME } from '@/lib/workspace-preferences';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { DraftScope } from '@/components/kept-field';
import {
  MainNav,
  MobileWorkspaceNavigation,
  NavigationPendingRegion,
  WorkspaceContext,
} from '@/components/main-nav';
import { MobileWorkspaceMenu } from '@/components/mobile-workspace-menu';
import { workspaceNavigation } from '@/components/navigation-model';
import { SubmitButton } from '@/components/submit-button';
import { signOutAction } from '@/server/actions';
import { requireAccountTenant } from '@/server/tenant';

export const viewport: Viewport = { viewportFit: 'cover' };

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
  const [organization, unread, pending, hasOtherWorkspace, cookieStore] = await Promise.all([
    getOrganization(database, context),
    countUnread(database, context),
    listMyPendingApprovals(database, context),
    hasOtherAccessibleOrganization(database, actor.userId, organizationId),
    cookies(),
  ]);
  if (!organization) notFound();
  const base = `/o/${organizationId}`;
  const navigation = workspaceNavigation({
    base,
    role: context.role,
    unread,
    pending: pending.length,
  });
  const workspaceSwitcher = hasOtherWorkspace && <OrganizationSwitcher current={organizationId} />;
  const account = (
    <div className="sidebar-end">
      <Link className="account-profile" href={`${base}/security`} title="Your account security">
        <Avatar className="account-avatar rounded-md" aria-hidden="true">
          <AvatarFallback className="rounded-md font-mono text-xs">
            {Array.from(actor.name)[0]?.toUpperCase() ?? 'E'}
          </AvatarFallback>
        </Avatar>
        <span className="account-details">
          <span className="account-name">{actor.name}</span>
          <span className="account-email" title={actor.email}>
            {actor.email}
          </span>
        </span>
      </Link>
      <form action={signOutAction}>
        <SubmitButton
          className="quiet account-sign-out"
          label="Sign out"
          title="Sign out"
          working="Signing out"
        >
          <LogOutIcon aria-hidden="true" />
        </SubmitButton>
      </form>
    </div>
  );

  return (
    <SidebarProvider
      className="block"
      defaultOpen={cookieStore.get(SIDEBAR_COOKIE_NAME)?.value !== 'false'}
      keyboardShortcut={false}
    >
      <NavigationPendingRegion>
        <div className="shell">
          <a className="skip" href="#main">
            Skip to content
          </a>
          <aside className="sidebar" id="workspace-sidebar" aria-label="Workspace sidebar">
            <div className="sidebar-inner">
              <div className="workspace-brand">
                <Link className="workspace-identity" href={base}>
                  <BrandMark />
                  <span className="workspace-name" title={organization.name}>
                    {organization.name}
                  </span>
                </Link>
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
            />
            <main id="main" tabIndex={0}>
              <DraftScope account={actor.userId}>{children}</DraftScope>
            </main>
            <MobileWorkspaceNavigation groups={navigation}>
              <MobileWorkspaceMenu>
                <div className="mobile-navigation-brand">
                  <Link className="brand" href={base}>
                    <BrandIdentity />
                  </Link>
                  {workspaceSwitcher}
                </div>
                <div className="mobile-navigation-scroll">
                  <MainNav groups={navigation} label="Mobile main" />
                </div>
                {account}
              </MobileWorkspaceMenu>
            </MobileWorkspaceNavigation>
          </div>
        </div>
      </NavigationPendingRegion>
    </SidebarProvider>
  );
}
