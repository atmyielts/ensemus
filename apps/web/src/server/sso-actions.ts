'use server';
import { redirectForSsoRefusal } from './interactive-refusal';
import { AppError } from '@ensemus/application';
import {
  createSsoConnection,
  prepareSsoMetadata,
  updateSsoConnection,
  issueScimToken,
  revokeScimToken,
} from '@ensemus/application/sso';
import {
  createSsoConnectionSchema,
  updateSsoConnectionSchema,
} from '@ensemus/contracts/identity-admin';
import { parseSamlMetadata } from '@ensemus/auth/sso';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnPath } from '@/lib/return-path';
import { stepUpPath } from '@/lib/step-up';
import type { TokenState } from '@/components/security-sso/token-form';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';
const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const home = (id: string) => `/o/${id}/security/sso`;
function failed(error: unknown, id: string): never {
  if (error instanceof Error && 'digest' in error) throw error;
  redirectForSsoRefusal(error);
  if (error instanceof AppError && error.code === 'MFA_REQUIRED')
    redirect(stepUpPath(id, home(id)));
  redirect(`${home(id)}?error=${error instanceof AppError ? error.code : 'UNAVAILABLE'}`);
}
export async function startSsoSignInAction(form: FormData) {
  const email = field(form, 'email').trim(),
    next = safeReturnPath(field(form, 'next'));
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email))
    redirect('/sign-in/sso?error=refused');
  const { auth, config } = getRuntime(),
    incoming = await headers(),
    forwarded = new Headers({
      'content-type': 'application/json',
      origin: new URL(config.publicUrl).origin,
    });
  for (const key of ['cookie', 'x-forwarded-for', 'user-agent']) {
    const value = incoming.get(key);
    if (value) forwarded.set(key, value);
  }
  const callback = new URL('/sso/complete', config.publicUrl);
  if (next) callback.searchParams.set('next', next);
  let target: string | null = null;
  try {
    const response = await auth.handler(
      new Request(new URL('/api/auth/sign-in/sso', config.publicUrl), {
        method: 'POST',
        headers: forwarded,
        body: JSON.stringify({
          email,
          providerType: 'saml',
          callbackURL: callback.href,
          errorCallbackURL: new URL('/sign-in/sso?error=refused', config.publicUrl).href,
        }),
      }),
    );
    if (response.status === 429) redirect('/sign-in/sso?error=rate');
    if (
      response.status === 503 &&
      (
        await response
          .clone()
          .json()
          .catch(() => null)
      )?.code === 'RESTORE_PENDING'
    )
      redirect('/restoring');
    if (response.ok) {
      const result = (await response.json()) as { url?: unknown };
      if (typeof result.url === 'string') {
        const url = new URL(result.url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const jar = await cookies();
          for (const [key, value] of parseSetCookieHeader(response.headers.get('set-cookie') ?? ''))
            jar.set(key, value.value, toCookieOptions(value));
          target = url.href;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && 'digest' in error) throw error;
  }
  redirect(target ?? '/sign-in/sso?error=refused');
}
/** Distinct native endpoint: ordinary Continue never silently connects an existing local account. */
export async function startSsoSelfLinkAction(form: FormData) {
  const next = safeReturnPath(field(form, 'next')),
    failure = next
      ? `/sign-in/sso?error=connect&next=${encodeURIComponent(next)}`
      : '/sign-in/sso?error=connect';
  if (field(form, 'consent') !== 'yes' || field(form, 'password').length > 128) redirect(failure);
  const { auth, config } = getRuntime(),
    incoming = await headers(),
    forwarded = new Headers({
      'content-type': 'application/json',
      origin: new URL(config.publicUrl).origin,
    });
  for (const key of ['cookie', 'x-forwarded-for', 'user-agent']) {
    const value = incoming.get(key);
    if (value) forwarded.set(key, value);
  }
  const callback = new URL('/sso/complete', config.publicUrl);
  if (next) callback.searchParams.set('next', next);
  let target: string | null = null;
  try {
    // The native router supplies authoritative session lookup, origin enforcement and its rate limit.
    const response = await auth.handler(
      new Request(new URL('/api/auth/sso/link-self', config.publicUrl), {
        method: 'POST',
        headers: forwarded,
        body: JSON.stringify({
          password: field(form, 'password'),
          callbackURL: callback.href,
          consent: 'connect',
        }),
      }),
    );
    if (response.status === 429) redirect('/sign-in/sso?error=rate');
    if (
      response.status === 503 &&
      (
        await response
          .clone()
          .json()
          .catch(() => null)
      )?.code === 'RESTORE_PENDING'
    )
      redirect('/restoring');
    if (response.ok) {
      const result = (await response.json()) as { url?: unknown };
      if (typeof result.url === 'string') {
        const url = new URL(result.url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const jar = await cookies();
          for (const [key, value] of parseSetCookieHeader(response.headers.get('set-cookie') ?? ''))
            jar.set(key, value.value, toCookieOptions(value));
          target = url.href;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && 'digest' in error) throw error;
  }
  redirect(target ?? failure);
}
export async function createSsoConnectionAction(id: string, form: FormData) {
  const { database, context, actor } = await requireTenant(id);
  try {
    const parsed = createSsoConnectionSchema.safeParse({
      display_name: field(form, 'displayName'),
      domain: field(form, 'domain').trim().toLowerCase(),
      idp_metadata_xml: field(form, 'metadata'),
    });
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const runtime = getRuntime();
    if (!parseSamlMetadata(parsed.data.idp_metadata_xml, runtime.config.publicUrl, 'validation'))
      redirect(`${home(id)}?error=METADATA`);
    const row = await createSsoConnection(
      database,
      context,
      { sessionId: actor.sessionId },
      { displayName: parsed.data.display_name, domain: parsed.data.domain },
    );
    const outcome = await runtime.sso.storeProvider({
      providerId: row.providerId,
      domain: row.domain,
      idpMetadataXml: parsed.data.idp_metadata_xml,
    });
    if (outcome !== 'stored') redirect(`${home(id)}?error=METADATA`);
  } catch (error) {
    failed(error, id);
  }
  redirect(`${home(id)}?notice=created`);
}
export async function updateSsoConnectionAction(id: string, connectionId: string, form: FormData) {
  const { database, context, actor } = await requireTenant(id);
  try {
    const parsed = updateSsoConnectionSchema.safeParse({
      display_name: field(form, 'displayName'),
      state: field(form, 'state'),
      auto_join: field(form, 'autoJoin') === 'on',
    });
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    await updateSsoConnection(
      database,
      context,
      { sessionId: actor.sessionId },
      {
        connectionId,
        expectedVersion: Number(field(form, 'version')),
        displayName: parsed.data.display_name!,
        state: parsed.data.state!,
        autoJoin: parsed.data.auto_join!,
      },
      { providerReady: async (providerId) => (await getRuntime().sso.status(providerId)).ready },
    );
  } catch (error) {
    failed(error, id);
  }
  redirect(`${home(id)}?notice=saved`);
}
export async function replaceSsoMetadataAction(id: string, connectionId: string, form: FormData) {
  const { database, context, actor } = await requireTenant(id);
  try {
    const runtime = getRuntime(),
      xml = field(form, 'metadata');
    if (!parseSamlMetadata(xml, runtime.config.publicUrl, 'validation'))
      redirect(`${home(id)}?error=METADATA`);
    const row = await prepareSsoMetadata(
      database,
      context,
      { sessionId: actor.sessionId },
      { connectionId, expectedVersion: Number(field(form, 'version')) },
    );
    if (
      (await runtime.sso.storeProvider({
        providerId: row.providerId,
        domain: row.domain,
        idpMetadataXml: xml,
      })) !== 'stored'
    )
      redirect(`${home(id)}?error=METADATA`);
  } catch (error) {
    failed(error, id);
  }
  redirect(`${home(id)}?notice=metadata`);
}
export async function issueScimTokenAction(
  id: string,
  connectionId: string,
  _state: TokenState,
  _form: FormData,
): Promise<TokenState> {
  const { database, context, actor } = await requireTenant(id);
  try {
    const result = await issueScimToken(
      database,
      context,
      { sessionId: actor.sessionId },
      { connectionId },
    );
    return { status: 'ready', token: result.token };
  } catch (error) {
    redirectForSsoRefusal(error);
    if (error instanceof AppError && error.code === 'MFA_REQUIRED')
      redirect(stepUpPath(id, home(id)));
    return { status: 'error' };
  }
}
export async function revokeScimTokenAction(id: string, tokenId: string, _form: FormData) {
  const { database, context, actor } = await requireTenant(id);
  try {
    await revokeScimToken(database, context, { sessionId: actor.sessionId }, { tokenId });
  } catch (error) {
    failed(error, id);
  }
  redirect(`${home(id)}?notice=revoked`);
}
