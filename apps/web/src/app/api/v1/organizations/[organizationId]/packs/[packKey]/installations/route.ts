import { idSchema } from '@ensemus/application';
import { requestPackInstall } from '@ensemus/application/packs';
import { requestPackInstallSchema } from '@ensemus/contracts/packs';
import { z } from 'zod';
import { apiRoute, readJson } from '@/server/api';
import { installationResponse } from '../../../pack-installations/dto';

export const dynamic = 'force-dynamic';

const params = z.object({
  organizationId: idSchema,
  packKey: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
});

// Starts a review and grants nothing. The same request again lands on the same open review.
export const POST = apiRoute(params, async ({ request, context, database, params: { packKey } }) => {
  const { version } = await readJson(request, requestPackInstallSchema);
  return installationResponse(
    await requestPackInstall(database, context, { packKey, version }),
    201,
  );
});
