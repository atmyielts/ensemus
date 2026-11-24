import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import { BackLink, PageHead } from '@/components/ui';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';
import { SkillPackageForm } from '../skill-package-form';

export const metadata = { title: 'New skill package | Ensemus' };

export default async function NewSkillPackagePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { context } = await requireTenant(organizationId);
  if (
    !can(context.role, 'skill.manage') ||
    !(await getSkillFeatureGate().isEnabled(context, 'skill_catalog'))
  )
    notFound();
  return (
    <>
      <BackLink href={`/o/${organizationId}/skills`}>Skill catalog</BackLink>
      <PageHead title="New package" />
      <SkillPackageForm organizationId={organizationId} />
    </>
  );
}
