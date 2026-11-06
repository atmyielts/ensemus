import { createPackService } from '@ensemus/application/packs';
import { apiRoute, readIfMatch } from '@/server/api';
import { webProductPorts } from '@/server/product-ports';
import { installationParams, installationResponse } from '../../dto';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  installationParams,
  async ({ request, sessionId, context, database, params }) =>
    installationResponse(
      await createPackService({ toolCatalog: webProductPorts().toolCatalog }).activatePack(
        database,
        context,
        { sessionId },
        { installationId: params.installationId, expectedVersion: readIfMatch(request) },
      ),
    ),
);
