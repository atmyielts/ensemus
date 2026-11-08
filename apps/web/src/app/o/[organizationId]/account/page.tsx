import { getTenantStanding } from '@ensemus/application/saas/standing';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { PageHead, formatDateTime } from '@/components/ui';
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
      'Work and agent activity are paused. Your data is kept, and billing, support, export and leaving remain available.',
  },
  offboarding: {
    title: 'Your organization is leaving',
    detail:
      'Work is paused while offboarding progresses. Billing, support and data retrieval remain available.',
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
  const base = `/o/${organizationId}/account`;
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
        <ul className="list">
          {can(tenant.context.role, 'billing.view') && (
            <li>
              <div>
                <Link href={`${base}/billing`}>Billing and subscription</Link>
                <p>Billing details, plan changes and cancellation.</p>
              </div>
            </li>
          )}
          <li>
            <div>
              <Link href={`${base}/support`}>Support</Link>
              <p>Ask for help with your account or its standing.</p>
            </div>
          </li>
          <li>
            <div>
              <Link href={`${base}/exports`}>Export your data</Link>
              <p>Retrieve your organization’s data, including while service is paused.</p>
            </div>
          </li>
          <li>
            <div>
              <Link href={`${base}/offboarding`}>Leave Ensemus</Link>
              <p>Review offboarding and the steps before erasure.</p>
            </div>
          </li>
        </ul>
      </nav>
    </div>
  );
}
