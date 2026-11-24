import { AppError, createPublisher, getPublisher } from '@ensemus/application';
import { createPublisherSchema } from '@ensemus/contracts/skills';
import { apiRoute, etag, organizationParams, readJson } from '@/server/api';
import { publisherDto, requireMarketplace } from '@/server/marketplace-api';
import { getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  await requireMarketplace(context);
  const row = await getPublisher(database, context);
  if (!row) throw new AppError('NOT_FOUND');
  return Response.json(publisherDto(row), { headers: { ETag: etag(row.version) } });
});

export const POST = apiRoute(organizationParams, async ({ context, database, request }) => {
  const body = await readJson(request, createPublisherSchema);
  const row = await createPublisher(database, context, getSkillFeatureGate(), {
    displayName: body.display_name,
  });
  return Response.json(publisherDto(row), { status: 201, headers: { ETag: etag(row.version) } });
});
