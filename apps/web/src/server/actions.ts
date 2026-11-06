'use server';

import { organizationNameSchema } from '@ensemus/contracts';
import { createOrganization } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
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
  const next = safeReturnPath(field(form, 'next'));
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
  redirect(failed ? withReturnPath('/sign-in?error=invalid', next) : (next ?? '/'));
}

export async function signUpAction(form: FormData) {
  const { auth, config, log } = getRuntime();
  const next = safeReturnPath(field(form, 'next'));
  if (!config.allowSignup) redirect(withReturnPath('/sign-in', next));
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
  redirect(failed ? withReturnPath('/sign-up?error=invalid', next) : (next ?? '/'));
}

/** The invitation page signs out here to switch account, and keeps its place by sending `next`. */
export async function signOutAction(form?: FormData) {
  await getRuntime().auth.api.signOut({ headers: await headers() });
  redirect(withReturnPath('/sign-in', safeReturnPath(form?.get('next'))));
}

export async function createOrganizationAction(form: FormData) {
  const actor = await requireActor();
  const { app, config, log } = getRuntime();
  const name = organizationNameSchema.safeParse(field(form, 'name'));
  if (!name.success) redirect('/?error=name');
  // Only ever hashed into an ID. Something that is not a key just gets no protection from repeats.
  const requestKey = z.uuid().safeParse(field(form, 'requestKey'));
  let target = '/?error=UNEXPECTED';
  try {
    const { organizationId } = await createOrganization(app, {
      userId: actor.userId,
      name: name.data,
      commercialMode: config.mode,
      ...(requestKey.success ? { requestKey: requestKey.data } : {}),
    });
    log.info('organization.created', { organizationId, userId: actor.userId });
    target = `/o/${organizationId}`;
  } catch (error) {
    log.error('organization.create_failed', { errorCode: errorCode(error) });
  }
  redirect(target);
}
