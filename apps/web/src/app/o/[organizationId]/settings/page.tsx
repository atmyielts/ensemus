import { getFederationSettings } from '@ensemus/application';
import { loadTenancyConfig } from '@ensemus/config';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import { visibleSettings } from '@/components/navigation-model';
import { DestinationList, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Administration | Ensemus' };

export default async function AdministrationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { context, database } = await requireTenant(organizationId);
  const destinations = visibleSettings(context.role);
  if (destinations.length === 0) notFound();
  const collaboration =
    loadTenancyConfig().crossOrgEnabled &&
    can(context.role, 'federation.view') &&
    (await getFederationSettings(database, context)).available;
  const base = `/o/${organizationId}`;
  return (
    <>
      <PageHead
        title="Administration"
        description="Your company’s sign-in and security, connected tools, and how AI is used and paid for."
      />
      <section className="settings-section" aria-labelledby="organization-controls">
        <div className="section-intro">
          <h2 id="organization-controls">Organization controls</h2>
          <p>Changes here apply to everyone in your company. Each page explains what it affects.</p>
        </div>
        <DestinationList
          label="Organization controls"
          items={[
            ...destinations.map((item) => ({
              href: base + '/' + item.path,
              label: item.label,
              description: item.description,
              icon: item.icon,
            })),
            ...(collaboration
              ? [
                  {
                    href: base + '/collaboration',
                    label: 'Collaboration',
                    description: 'Review invitations and manage grants with other organizations',
                    icon: 'connections' as const,
                  },
                ]
              : []),
          ]}
        />
      </section>
    </>
  );
}
