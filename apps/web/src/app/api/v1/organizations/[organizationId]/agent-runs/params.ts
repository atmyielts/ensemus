import { idSchema } from '@ensemus/application';
import { z } from 'zod';

/** What every route about one run is addressed by. */
export const agentRunParams = z.object({ organizationId: idSchema, agentRunId: idSchema });
