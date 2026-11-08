import 'server-only';
import { AppError } from '@ensemus/application';
import { canProduct } from '@ensemus/domain/product-policy';
import { notFound } from 'next/navigation';
import { requireTenant } from './tenant';
export async function requireStudio(organizationId: string) {
  const tenant = await requireTenant(organizationId);
  if (tenant.context.actorType !== 'user' || !canProduct(tenant.context.role, 'studio.author'))
    notFound();
  return tenant;
}
export async function studioRead<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (
      error instanceof AppError &&
      ['NOT_FOUND', 'FORBIDDEN', 'INVALID_INPUT'].includes(error.code)
    )
      notFound();
    throw error;
  }
}
