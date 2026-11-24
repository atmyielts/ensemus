import { getListing, idSchema } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { listingDto } from '@/server/marketplace-api';
import { getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(
  organizationParams.extend({ listingId: idSchema }),
  async ({ context, database, params }) =>
    Response.json(
      listingDto(await getListing(database, context, getSkillFeatureGate(), params.listingId)),
    ),
);
