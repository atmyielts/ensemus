import { getTenantStanding } from '@ensemus/application/saas/standing';
import { DestinationList, PageHead, formatDateTime } from '@/components/ui';
import { accountDestinations } from '@/lib/account-destinations';
import { orNotFound, requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Account | Ensemus' };
const standingText: Record<string, { title: string; detail: string }> = {
  active: {
    title: 'Your organization is active',
    detail: 'Your account is available. The approved plan and existing permissions govern access.',
  },
  read_only: {
    title: 'Your organization is read-only',
    detail:
      'You can read existing work. Changes are paused while the account issue is resolved. Your data is kept.',
  },
  suspended: {
    title: 'Your organization is suspended',
    detail:
      'Work and agent activity are paused. Your data is kept. The account options below remain available according to your role.',
  },
  offboarding: {
    title: 'Your organization is leaving',
    detail:
      'Work is paused during the transition. The account options available to your role appear below.',
  },
};
export default async function AccountPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const tenant = await requireAccountTenant(organizationId);
  const status = await orNotFound(getTenantStanding(tenant.database, tenant.context));
  const words = standingText[status.lifecycle]!;
  const destinations = accountDestinations(organizationId, tenant.context.role);
  return (
    <div className="stack">
      <PageHead
        title="Account"
        description="Manage your organization’s account and access your data."
      />
      <section className="panel" aria-labelledby="account-standing">
        <h2 id="account-standing">{words.title}</h2>
        <p>{words.detail}</p>
        {status.reasonCode && (
          <p>
            Reason: {status.reasonCode.toLowerCase().replaceAll('_', ' ')}.
            {status.changedAt && <> Changed {formatDateTime(status.changedAt)}.</>}
          </p>
        )}
      </section>
      <nav aria-label="Account settings">
        <DestinationList items={destinations} label="Account destinations" />
      </nav>
    </div>
  );
}
