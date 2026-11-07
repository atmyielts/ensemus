'use server';
import { AppError, auditRefusal, isAuditedRefusal, refusalCode } from '@ensemus/application';
import {
  getOutcomeDraft,
  reviseOutcomeDraft,
  authorizeOutcome,
  discardOutcome,
} from '@ensemus/application/outcomes';
import { decideOnboardingStep, startFirstSimulation } from '@ensemus/application/onboarding';
import { composeOutcomeSchema } from '@ensemus/contracts/experience';
import { ONBOARDING_STEPS } from '@ensemus/domain/onboarding';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  experienceText,
  experienceId,
  experienceVersion,
  experienceValues,
  previewFromForm,
  type ExperienceFormState,
} from '@/lib/experience-input';
import { requireTenant } from './tenant';
import { getRuntime } from './runtime';
import { composeOnce } from './experience-api';
import { webProductPorts } from './product-ports';
type Tenant = Awaited<ReturnType<typeof requireTenant>>;
async function run(
  state: ExperienceFormState,
  form: FormData,
  effect: (t: Tenant, org: string) => Promise<string>,
): Promise<ExperienceFormState> {
  const org = experienceId(form, 'organizationId'),
    tenant = await requireTenant(org);
  let path: string;
  try {
    path = await effect(tenant, org);
    revalidatePath(`/o/${org}/compose`, 'layout');
    revalidatePath(`/o/${org}/get-started`);
  } catch (error) {
    if (isAuditedRefusal(error))
      await auditRefusal(tenant.database, tenant.context, {
        surface: 'web',
        code: refusalCode(error),
      }).catch((e) => getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(e) }));
    if (error instanceof AppError && error.code === 'SSO_REQUIRED') redirect('/sign-in/sso');
    if (!(error instanceof AppError)) throw error;
    return {
      code: error.code,
      values: experienceValues(form),
      revision: (state.revision ?? 0) + 1,
    };
  }
  redirect(path);
}
export async function composeOutcomeAction(state: ExperienceFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    const input = composeOutcomeSchema.safeParse({
      objective: experienceText(form, 'objective'),
      today: experienceText(form, 'today'),
    });
    if (!input.success) throw new AppError('INVALID_INPUT');
    const d = await composeOnce(database, context, experienceId(form, 'requestKey'), input.data);
    return `/o/${org}/compose/${d.id}`;
  });
}
export async function reviseOutcomeAction(state: ExperienceFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    const id = experienceId(form, 'draftId'),
      draft = await getOutcomeDraft(database, context, id);
    await reviseOutcomeDraft(database, context, {
      draftId: id,
      expectedVersion: experienceVersion(form),
      preview: previewFromForm(form, draft.preview),
    });
    return `/o/${org}/compose/${id}?saved=1`;
  });
}
export async function confirmOutcomeAction(state: ExperienceFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    if (experienceText(form, 'confirmed') !== 'yes') throw new AppError('INVALID_INPUT');
    const result = await authorizeOutcome(database, context, {
      draftId: experienceId(form, 'draftId'),
      expectedVersion: experienceVersion(form),
      previewSha256: experienceText(form, 'previewSha256'),
    });
    return `/o/${org}/work/${result.workUnitId}`;
  });
}
export async function discardOutcomeAction(state: ExperienceFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    await discardOutcome(database, context, {
      draftId: experienceId(form, 'draftId'),
      expectedVersion: experienceVersion(form),
    });
    return `/o/${org}/compose`;
  });
}
export async function decideSetupAction(state: ExperienceFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    const step = ONBOARDING_STEPS.find((s) => s === experienceText(form, 'step')),
      decision = experienceText(form, 'decision');
    if (
      !step ||
      !['acknowledged', 'skipped'].includes(decision) ||
      (decision === 'acknowledged' && experienceText(form, 'confirmed') !== 'yes')
    )
      throw new AppError('INVALID_INPUT');
    await decideOnboardingStep(database, context, webProductPorts(), {
      step,
      decision: decision as 'acknowledged' | 'skipped',
    });
    return `/o/${org}/get-started`;
  });
}
export async function firstSimulationAction(state: ExperienceFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    await startFirstSimulation(database, context, {
      processKey: experienceText(form, 'processKey'),
    });
    return `/o/${org}/get-started`;
  });
}
