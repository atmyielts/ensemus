import { idSchema, removeInstallation } from '@ensemus/application';
import { apiRoute, organizationParams, readIfMatch } from '@/server/api';

export const dynamic = 'force-dynamic';

export const DELETE = apiRoute(
  organizationParams.extend({ installationId: idSchema }),
  async ({ context, database, params, request }) => {
    const expectedVersion = readIfMatch(request);
    await removeInstallation(database, context, {
      installationId: params.installationId,
      expectedVersion,
    });
    return new Response(null, { status: 204 });
  },
);
