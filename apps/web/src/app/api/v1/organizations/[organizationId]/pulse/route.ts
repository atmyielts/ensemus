import { getCompanyPulse } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { pulseQuerySchema } from '@ensemus/contracts/experience';
import { apiRoute, organizationParams, readQuery } from '@/server/api';
import { pulseDto } from '@/server/pulse-api';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database, request }) => {
  const input = readQuery(request, pulseQuerySchema);
  return Response.json(
    pulseDto(
      await getCompanyPulse(database, context, createPulseMetadataReaders(), {
        includeDismissed: input.include_dismissed,
      }),
    ),
  );
});
