import { getPackInstallation } from '@ensemus/application/packs';
import { apiRoute } from '@/server/api';
import { installationParams, installationResponse } from '../dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(installationParams, async ({ context, database, params }) =>
  installationResponse(await getPackInstallation(database, context, params.installationId)),
);
