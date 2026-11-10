import { getLicenseStatus, listAdvisories } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import { LicenseAdvisories } from '@/components/license-advisories';
import { LicenseInstallForm } from '@/components/license-install-form';
import {
  LicenseNoticeList,
  LicenseTestKeyBanner,
  LicenseTrustRootNotice,
} from '@/components/license-notice-list';
import { LicenseSummary } from '@/components/license-summary';
import { PageHead } from '@/components/ui';
import { getSovereignRuntime } from '@/server/sovereign-runtime';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'License and support | Ensemus' };

// What this organization's signed documents say (COMM-03, SOV-02, SOV-04). Only this page and the API read
// them, and only to show a person. Nothing about them can stop the software (ADR-030 D2).
export default async function LicensePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { context, database } = await requireTenant(organizationId);
  // The usual not found for a member, so this page says nothing to anyone it is not for.
  if (!can(context.role, 'license.view')) notFound();

  const { trustRoot, trustRootState, runningRelease } = getSovereignRuntime();
  const deps = { trustRoot, runningRelease };
  const [status, advisories] = await Promise.all([
    getLicenseStatus(database, context, deps),
    listAdvisories(database, context, deps),
  ]);
  const testKey =
    status.notices.includes('signed_with_test_key') || advisories.some((item) => item.testKey);

  return (
    <>
      {testKey && <LicenseTestKeyBanner />}
      <PageHead
        title="License and support"
        description="What your signed documents say. This is for you to read: a lapse, a missing file or a wrong clock changes what this page says, and the software keeps running."
      />
      <LicenseTrustRootNotice state={trustRootState} />
      <LicenseNoticeList notices={status.notices} />
      <div className="stack">
        <LicenseSummary status={status} />
        <LicenseAdvisories advisories={advisories} />
        <section className="panel" aria-labelledby="license-install">
          <h2 id="license-install">Install a signed document</h2>
          {can(context.role, 'license.manage') ? (
            <>
              <p>
                A license, a maintenance statement, an advisory or a support policy. A file that
                does not verify changes nothing.
              </p>
              <LicenseInstallForm organizationId={organizationId} />
            </>
          ) : (
            <p className="muted" data-denied="license-install">
              You can read this page. Only an owner can install a signed document.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
