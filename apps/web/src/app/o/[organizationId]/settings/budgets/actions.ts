'use server';

// A public endpoint, like every action. It resolves the person and tenant again from the session, and
// `setBudget` checks permission itself, so nothing in the form's hidden fields decides anything.
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { setBudget } from '@ensemus/application/ai-budget';
import { usdToMicros } from '@ensemus/domain/ai';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));

/** A person types dollars, and from here on it is whole micro-USD. Anything finer is refused. */
function limitFrom(form: FormData): number {
  try {
    return usdToMicros(text(form, 'limitUsd').trim());
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

export async function setBudgetAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId');
  const { context, database } = await requireTenant(organizationId);
  const period = text(form, 'period');
  const back = `/o/${organizationId}/settings/budgets`;
  // The page checks this before using it, so a forged month only ever shows this month.
  const samePage = `${back}?period=${encodeURIComponent(period)}`;
  let target = samePage;
  try {
    const on = text(form, 'target');
    await setBudget(database, context, {
      scope: on === 'organization' ? 'organization' : 'agent_version',
      agent_version_id: on === 'organization' ? null : canonicalId(on),
      period,
      limit_micros: limitFrom(form),
    });
    revalidatePath(back);
  } catch (error) {
    const { log } = getRuntime();
    if (isAuditedRefusal(error)) {
      await auditRefusal(database, context, { code: refusalCode(error), surface: 'web' }).catch(
        (failure: unknown) => log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    }
    if (error instanceof AppError) {
      target = `${samePage}&error=${error.code}`;
    } else {
      log.error('action.failed', { errorCode: errorCode(error) });
      target = `${samePage}&error=UNEXPECTED`;
    }
  }
  redirect(target);
}
