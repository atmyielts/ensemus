// Where Google and Microsoft send the admin back after consent (ADR-038 D1). One fixed address, because
// providers require an exact registered match, so the tenant comes from the state and the person from the
// session cookie. It reads five parameters and no others, never logs or echoes the code or the state, and
// always ends in a redirect to the connections page, which shows how it went in plain words.
import { randomUUID } from 'node:crypto';
import {
  AppError,
  auditRefusal,
  isAuditedRefusal,
  receiveCallback,
  refusalCode,
} from '@ensemus/application';
import { assertServing } from '@ensemus/application/saas/standing';
import { assertTenantSignIn } from '@ensemus/application/sso';
import { oauthCallbackQuerySchema } from '@ensemus/contracts/workspace-suites';
import {
  isRestoreAdmissionDenied,
  resolveInteractiveTenantContext,
  TenantAccessDenied,
  type TenantContext,
} from '@ensemus/database';
import { parseOAuthState } from '@ensemus/domain/workspace-suites';
import { errorCode } from '@ensemus/telemetry';
import { apiLog, toErrorResponse } from '@/server/api';
import { oauthWebSide } from '@/server/oauth';
import { getRestoreGate, getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const READ = ['state', 'code', 'error', 'admin_consent', 'tenant'] as const;

const stateInvalid = () => new AppError('OAUTH_STATE_INVALID');

function redirectTo(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: new URL(path, getRuntime().config.publicUrl).toString() },
  });
}

/** Only the parameters ADR-038 D1 names. Providers send others, such as `scope` or `iss`, unread. */
function queryOf(request: Request) {
  const params = new URL(request.url).searchParams;
  const read: Record<string, string> = {};
  for (const name of READ) {
    const value = params.get(name);
    if (value !== null) read[name] = value;
  }
  return oauthCallbackQuerySchema.safeParse(read);
}

export async function GET(request: Request) {
  const requestId = randomUUID();
  let response: Response;
  let context: TenantContext | undefined;
  try {
    const { app, readInteractiveSession } = getRuntime();
    const query = queryOf(request);
    const state = query.success ? parseOAuthState(query.data.state) : null;
    // A mangled address, or a state we could not have made: the same answer as every other failure.
    if (!query.success || !state) throw stateInvalid();
    const session = await readInteractiveSession(request.headers);
    // Nothing is kept for a later sign-in: the attempt expires on its own, and the admin starts again.
    if (!session) return finish(redirectTo('/sign-in'), requestId);
    try {
      context = await resolveInteractiveTenantContext(app, session.identity, state.organizationId);
    } catch (error) {
      // Someone outside the tenant in the state learns no more than from any other bad state.
      if (error instanceof TenantAccessDenied) throw stateInvalid();
      throw error;
    }
    await getRestoreGate().assertServing(context);
    await assertTenantSignIn(app, context, { sessionId: session.session.id });
    assertServing(context, 'core');
    const { state: rawState, code, error, admin_consent: adminConsent, tenant } = query.data;
    const result = await receiveCallback(
      app,
      context,
      {
        state: rawState,
        ...(code !== undefined ? { code } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(adminConsent !== undefined
          ? { adminConsent: adminConsent.toLowerCase() === 'true' }
          : {}),
        ...(tenant !== undefined ? { tenant } : {}),
      },
      oauthWebSide(app, context),
    );
    response = redirectTo(
      `/o/${context.organizationId}/connections?authorization=${result.authorizationId}`,
    );
  } catch (error) {
    response = await answerFailure(error, requestId, context);
  }
  return finish(response, requestId);
}

function finish(response: Response, requestId: string): Response {
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('Cache-Control', 'no-store');
  // The address that brought the browser here held the code. Nothing after it should name it.
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

async function answerFailure(
  error: unknown,
  requestId: string,
  context: TenantContext | undefined,
): Promise<Response> {
  if (context && isAuditedRefusal(error)) {
    await auditRefusal(getRuntime().app, context, {
      code: refusalCode(error),
      surface: 'api',
    }).catch((failure: unknown) =>
      apiLog.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
    );
  }
  if (isRestoreAdmissionDenied(error)) return redirectTo('/restoring');
  if (error instanceof AppError) {
    if (error.code === 'RESTORE_PENDING') return redirectTo('/restoring');
    if (error.code === 'SSO_REQUIRED') return redirectTo('/sign-in/sso');
    // A member of this tenant goes back to the page they started from, with one of our own codes.
    if (context) return redirectTo(`/o/${context.organizationId}/connections?error=${error.code}`);
  }
  return toErrorResponse(error, requestId);
}
