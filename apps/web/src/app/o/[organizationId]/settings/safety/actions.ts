'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session, and
// the service checks `ai.halt` again, so nothing here trusts a hidden field for who is asking. A global or
// provider stop cannot be asked for from here at all: the service refuses those scopes.
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { engageKillSwitch, releaseKillSwitch } from '@ensemus/application/ai-halt';
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

type Tenant = Awaited<ReturnType<typeof requireTenant>>;

/** Goes back to the page, with a known code and never a raw message, and leaves a record of a refusal. */
async function act(tenant: Tenant, back: string, action: () => Promise<void>): Promise<never> {
  let target = back;
  try {
    await action();
    revalidatePath(back);
  } catch (error) {
    if (isAuditedRefusal(error)) {
      await auditRefusal(tenant.database, tenant.context, {
        code: refusalCode(error),
        surface: 'web',
      }).catch((failure: unknown) =>
        getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    }
    if (error instanceof AppError) {
      target = `${back}?error=${error.code}`;
    } else {
      getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
      target = `${back}?error=UNEXPECTED`;
    }
  }
  redirect(target);
}

const pageOf = (organizationId: string) => `/o/${organizationId}/settings/safety`;

/** Stopping agents is meant to be easy, and still has to be meant. Browsers check the box, and so does this. */
function assertConfirmed(form: FormData) {
  if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
}

export async function engageKillSwitchAction(form: FormData) {
  const org = idOf(form, 'organizationId');
  const tenant = await requireTenant(org);
  await act(tenant, pageOf(org), async () => {
    assertConfirmed(form);
    const target = text(form, 'target');
    await engageKillSwitch(tenant.database, tenant.context, {
      scope: text(form, 'scope') as 'organization' | 'agent_version',
      target_ref: target ? target : null,
      reason_code: text(form, 'reasonCode'),
    });
  });
}

export async function releaseKillSwitchAction(form: FormData) {
  const org = idOf(form, 'organizationId');
  const tenant = await requireTenant(org);
  await act(tenant, pageOf(org), async () => {
    assertConfirmed(form);
    await releaseKillSwitch(tenant.database, tenant.context, {
      switchId: idOf(form, 'switch'),
    });
  });
}
