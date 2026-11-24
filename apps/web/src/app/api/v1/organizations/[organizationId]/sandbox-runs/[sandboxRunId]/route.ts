import { getSandboxRun, idSchema } from '@ensemus/application';
import { apiRoute, etag, organizationParams } from '@/server/api';
import { sandboxRunDto } from '@/server/sandbox-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(
  organizationParams.extend({ sandboxRunId: idSchema }),
  async ({ database, context, params }) => {
    const row = await getSandboxRun(database, context, params.sandboxRunId);
    return Response.json(sandboxRunDto(row), { headers: { ETag: etag(row.version) } });
  },
);
