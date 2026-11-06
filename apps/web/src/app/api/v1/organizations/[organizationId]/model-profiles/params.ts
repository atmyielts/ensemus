import { idSchema } from '@ensemus/application';
import { z } from 'zod';

export const modelProfileParams = z.object({
  organizationId: idSchema,
  modelProfileId: idSchema,
});
