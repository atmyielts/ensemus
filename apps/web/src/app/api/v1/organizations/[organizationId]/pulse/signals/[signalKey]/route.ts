import { setPulseSignalState } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { setPulseSignalStateSchema } from '@ensemus/contracts/experience';
import { z } from 'zod';
import { apiRoute, organizationParams, readJson } from '@/server/api';

const params = organizationParams.extend({ signalKey: z.string().min(1).max(128) });
export const PUT = apiRoute(params, async ({ context, database, request, params: route }) => {
  const input = await readJson(request, setPulseSignalStateSchema);
  await setPulseSignalState(database, context, createPulseMetadataReaders(), {
    signalKey: route.signalKey,
    state: input.state,
    ...(input.until ? { until: new Date(input.until) } : {}),
  });
  return new Response(null, { status: 204 });
});
