import { decideOnboardingStep } from '@ensemus/application/onboarding';
import { decideOnboardingStepSchema } from '@ensemus/contracts/experience';
import { ONBOARDING_STEPS } from '@ensemus/domain/onboarding';
import { z } from 'zod';
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { onboardingDto } from '@/server/experience-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams.extend({ stepKey: z.enum(ONBOARDING_STEPS) }),
  async ({ database, context, params, request }) =>
    Response.json(
      onboardingDto(
        await decideOnboardingStep(database, context, webProductPorts(), {
          step: params.stepKey,
          ...(await readJson(request, decideOnboardingStepSchema)),
        }),
      ),
    ),
);
