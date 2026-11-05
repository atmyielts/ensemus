import {
  getOrganization,
  listMembers,
  resolveTenantContext,
  TenantAccessDenied,
} from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/server/actor';
import { getRuntime } from '@/server/runtime';

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const actor = await requireActor();
  const { organizationId } = await params;
  const { app } = getRuntime();

  // A forbidden organization looks exactly like one that does not exist.
  const context = await resolveTenantContext(app, actor.userId, organizationId).catch(
    (error: unknown) => {
      if (error instanceof TenantAccessDenied) notFound();
      throw error;
    },
  );
  const organization = await getOrganization(app, context);
  if (!organization) notFound();
  const members = await listMembers(app, context);

  return (
    <main>
      <p>
        <Link href="/">All organizations</Link>
      </p>
      <h1>{organization.name}</h1>
      <h2>Members</h2>
      <ul>
        {members.map((member) => (
          <li key={member.membershipId}>
            {member.name} <span className="muted">({member.role})</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
