import 'server-only';
import { listMyOrganizations, resolveTenantContext, TenantAccessDenied } from '@ensemus/database';
import { getRuntime } from './runtime';

/** Someone whose access was disabled is still a row in the list, but no longer has the access. */
export async function organizationsWithAccess(userId: string) {
  const { app } = getRuntime();
  const all = await listMyOrganizations(app, userId);
  const usable = await Promise.all(
    all.map((organization) =>
      resolveTenantContext(app, userId, organization.id).then(
        () => true,
        (error: unknown) => {
          if (error instanceof TenantAccessDenied) return false;
          throw error;
        },
      ),
    ),
  );
  return all.filter((_, index) => usable[index]);
}
