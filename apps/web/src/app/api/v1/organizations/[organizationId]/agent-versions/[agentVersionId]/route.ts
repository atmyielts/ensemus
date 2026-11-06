import { idSchema } from '@ensemus/application';
import { getAgentVersion } from '@ensemus/application/ai-agents';
import { z } from 'zod';
import { apiRoute } from '@/server/api';

export const dynamic = 'force-dynamic';

const params = z.object({ organizationId: idSchema, agentVersionId: idSchema });

/** The record of one version. Its spec stays out of this answer: the fields shown are all there is. */
export const GET = apiRoute(params, async ({ context, database, params: { agentVersionId } }) =>
  Response.json(await getAgentVersion(database, context, agentVersionId)),
);
