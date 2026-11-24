import { cancelSandboxRun, idSchema } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  organizationParams.extend({ sandboxRunId: idSchema }),
  async ({ database, context, params }) => {
    await cancelSandboxRun(database, context, params.sandboxRunId);
    return new Response(null, { status: 202 });
  },
);
