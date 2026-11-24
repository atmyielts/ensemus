import { AppError, getInboundItem, idSchema } from '@ensemus/application';
import { loadTenancyConfig } from '@ensemus/config';
import { notFound, redirect } from 'next/navigation';
import { requireTenant } from '@/server/tenant';

export default async function ReceivedItemTarget({
  params,
}: {
  params: Promise<{ organizationId: string; itemId: string }>;
}) {
  if (!loadTenancyConfig().crossOrgEnabled) notFound();
  const { organizationId, itemId } = await params;
  if (!idSchema.safeParse(itemId).success) notFound();
  const { context, database } = await requireTenant(organizationId);
  const item = await getInboundItem(database, context, itemId).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  });
  redirect(`/o/${organizationId}/collaboration/${item.grantId}#received-${item.id}`);
}
