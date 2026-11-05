'use server';

import { organizationNameSchema } from '@ensemus/contracts';
import { createOrganization } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireActor } from './actor';
import { getRuntime } from './runtime';

// Every action is a public endpoint: each one validates input and resolves the actor itself. None
// captures values in a closure, so nothing sensitive is ever serialized to the browser.

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export async function signInAction(form: FormData) {
  const { auth, log } = getRuntime();
  let failed = false;
  try {
    await auth.api.signInEmail({
      body: { email: field(form, 'email'), password: field(form, 'password') },
      headers: await headers(),
    });
  } catch (error) {
    failed = true;
    log.info('auth.sign_in_failed', { errorCode: errorCode(error) });
  }
  redirect(failed ? '/sign-in?error=invalid' : '/');
}

export async function signUpAction(form: FormData) {
  const { auth, config, log } = getRuntime();
  if (!config.allowSignup) redirect('/sign-in');
  let failed = false;
  try {
    await auth.api.signUpEmail({
      body: {
        name: field(form, 'name'),
        email: field(form, 'email'),
        password: field(form, 'password'),
      },
      headers: await headers(),
    });
  } catch (error) {
    failed = true;
    log.info('auth.sign_up_failed', { errorCode: errorCode(error) });
  }
  redirect(failed ? '/sign-up?error=invalid' : '/');
}

export async function signOutAction() {
  await getRuntime().auth.api.signOut({ headers: await headers() });
  redirect('/sign-in');
}

export async function createOrganizationAction(form: FormData) {
  const actor = await requireActor();
  const { app, config, log } = getRuntime();
  const name = organizationNameSchema.safeParse(field(form, 'name'));
  if (!name.success) redirect('/?error=name');
  const { organizationId } = await createOrganization(app, {
    userId: actor.userId,
    name: name.data,
    commercialMode: config.mode,
  });
  log.info('organization.created', { organizationId, userId: actor.userId });
  redirect(`/o/${organizationId}`);
}
