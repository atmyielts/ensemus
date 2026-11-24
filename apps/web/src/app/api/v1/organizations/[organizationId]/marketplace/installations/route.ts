import {
  AppError,
  listInstallations,
  requestHash,
  requestInstallation,
  runIdempotent,
} from '@ensemus/application';
import { requestInstallationSchema } from '@ensemus/contracts/skills';
import { can } from '@ensemus/domain/policy';
import { apiRoute, etag, idempotencyKeyReused, organizationParams, readJson } from '@/server/api';
import { installationDto, requireMarketplace } from '@/server/marketplace-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  await requireMarketplace(context);
  return Response.json({
    items: (await listInstallations(database, context)).map(installationDto),
  });
});

export const POST = apiRoute(organizationParams, async ({ context, database, request }) => {
  if (context.actorType !== 'user' || !can(context.role, 'marketplace.install'))
    throw new AppError('FORBIDDEN');
  const body = await readJson(request, requestInstallationSchema);
  const gate = await requireMarketplace(context);
  const result = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash(['POST', 'marketplace/installations', body.listing_id]),
    },
    (joined) => requestInstallation(joined, context, gate, { listingId: body.listing_id }),
    (row) => ({ status: 202, body: installationDto(row) }),
  );
  if (result.kind === 'conflict') throw idempotencyKeyReused();
  const row = result.body as ReturnType<typeof installationDto>;
  return Response.json(row, { status: result.status, headers: { ETag: etag(row.version) } });
});
