// Embedded authentication (ADR-024 D5, ID-03): local accounts and optional OIDC, with no hosted
// identity service, so it works unchanged in an air-gapped install.
import {
  authSchema,
  claimSetupToken,
  openAuthDatabase,
  recordSessionAssurance,
  revokeSessionAssurances,
  reserveMfaAttempt,
  readMfaEnrollmentState,
  releaseSetupToken,
  removeSsoProvider,
  storeSsoProvider,
  readSsoProvider,
  recordSsoAssurance,
  createVerifiedInteractiveIdentity,
} from '@ensemus/database/auth';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';
import { createMfaOperations, mfaPlugins, MFA_PRIVATE_PATHS, MFA_ACCOUNT_LOCKOUT } from './mfa';
import { createMfaAdmission } from './mfa-admission';
import { createPrimaryAuthentication } from './mfa-primary';
import { createSsoOperations, SSO_DISABLED_PATHS, ssoPlugins, type SsoCallbacks } from './sso';
import { createSamlFlow } from './sso-flow';
import { guardSamlRequest } from './sso-request';
import { createOperatorOidcFlow, type OidcTrust } from './oidc-primary';
import { createIdpChallenges } from './idp-challenge';
import { createSamlBrowserFlow } from './saml-browser-flow';
import { createSamlSelfLinkPlugin } from './saml-self-link';

export type OidcProvider = {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
};

export type AuthOptions = {
  databaseUrl: string;
  secret: string;
  baseURL: string;
  allowSignup: boolean;
  oidc?: OidcProvider;
  /** Trusted application bindings, never assertion-supplied roles or organization IDs. */
  sso?: SsoCallbacks;
  /** Framework plugins, such as Next.js cookies. They run last. */
  plugins?: BetterAuthPlugin[];
};

const log = createLogger('auth');

/**
 * Better Auth logs whole error objects, and an ORM error quotes its SQL and its parameters, which
 * here means email addresses. Only a fixed event and an error code ever leave this function.
 */
export function logSafely(level: string, _message: string, ...args: unknown[]) {
  const error = args.find((arg) => arg instanceof Error);
  const fields = error ? { errorCode: errorCode(error) } : {};
  if (level === 'error') log.error('auth.error', fields);
  else if (level === 'warn') log.warn('auth.warning', fields);
}

export type SetupAccount = { token: string; name: string; email: string; password: string };
export type SetupOutcome = 'created' | 'invalid_token' | 'invalid_details';

export type CredentialForm =
  | { path: '/sign-in/email'; body: { email: string; password: string } }
  | { path: '/sign-up/email'; body: { name: string; email: string; password: string } };

export type CredentialOutcome = {
  outcome: 'accepted' | 'two_factor' | 'refused' | 'rate_limited';
  /** The HTTP status behind the outcome, for the log. */
  status: number;
  /** The cookies to set, which the caller's framework has to pass on to the browser. */
  setCookie: string | null;
};

/** What the limits and the session record read. Nothing else from the form's request is passed on. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'user-agent'];
const TOO_MANY_REQUESTS = 429;

export function createAuth(options: AuthOptions) {
  const { db, close } = openAuthDatabase(options.databaseUrl);
  let currentOidcTrust: () => Promise<OidcTrust | null> = async () => null;
  const primary = createPrimaryAuthentication(
    db,
    options.secret,
    options.oidc?.providerId,
    options.sso,
    () => currentOidcTrust(),
  );
  const oidcFlow = createOperatorOidcFlow(options.oidc, (input) => primary.recordOidc(input));
  const samlFlow = createSamlFlow(async (input) => {
    if (!options.sso || (await options.sso.completeIdentity(input)) === 'refused') return false;
    if (!(await primary.recordSaml(input))) return false;
    // The signed identity may legitimately have no company membership. That creates no membership,
    // SSO tenant assurance, or MFA bootstrap authority; /sso/complete explains the missing access.
    if (await options.sso?.currentPrimary(input))
      return recordSsoAssurance(db, {
        sessionId: input.sessionId,
        userId: input.userId,
        providerId: input.providerId,
        externalSubject: input.externalSubject,
        expectedSha256: input.boundary,
      });
    return true;
  });
  const samlBrowser = createSamlBrowserFlow({
    database: db,
    secret: options.secret,
    baseURL: options.baseURL,
    providerPrimaryCurrent: (receipt) => primary.selfLinkProviderCurrent(receipt),
  });
  const idpChallenges = createIdpChallenges(
    db,
    options.secret,
    options.baseURL,
    options.oidc?.providerId,
    {
      prepare: (input) => {
        const identity = { userId: input.userId, sessionId: input.sourceSessionId };
        if (input.kind === 'saml') {
          const candidate = samlFlow.candidate();
          return candidate && candidate.providerId === input.providerId
            ? primary.prepareIdpChallenge(identity, { ...candidate, kind: 'saml' })
            : Promise.resolve(null);
        }
        const candidate = oidcFlow.candidate();
        return candidate && candidate.providerId === input.providerId
          ? primary.prepareIdpChallenge(identity, { ...candidate, kind: 'oidc' })
          : Promise.resolve(null);
      },
      finish: (input) => primary.finishIdpChallenge(input),
    },
  );
  const build = (allowSignup: boolean, privateFactorManagement = false) =>
    betterAuth({
      appName: 'Ensemus',
      baseURL: options.baseURL,
      secret: options.secret,
      trustedOrigins: [options.baseURL],
      disabledPaths: [...SSO_DISABLED_PATHS, ...(privateFactorManagement ? [] : MFA_PRIVATE_PATHS)],
      telemetry: { enabled: false },
      logger: { log: logSafely },
      database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true }),
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        disableSignUp: !allowSignup,
      },
      session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
      // Provider tokens are not kept readable in the identity tables.
      account: { encryptOAuthTokens: true },
      rateLimit: {
        enabled: true,
        storage: 'database',
        window: 60,
        max: 100,
        customRules: {
          '/sign-in/email': { window: 60, max: 10 },
          '/sign-up/email': { window: 60, max: 5 },
          '/sso/link-self': { window: 60, max: 5 },
        },
      },
      advanced: {
        database: { generateId: 'uuid' },
        useSecureCookies: options.baseURL.startsWith('https://'),
        defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      },
      plugins: [
        ...(options.oidc && !privateFactorManagement
          ? [
              genericOAuth({
                config: [
                  {
                    providerId: options.oidc.providerId,
                    clientId: options.oidc.clientId,
                    clientSecret: options.oidc.clientSecret,
                    discoveryUrl: options.oidc.discoveryUrl,
                    scopes: ['openid', 'email', 'profile'],
                    pkce: true,
                  },
                ],
              }),
            ]
          : []),
        ...mfaPlugins(privateFactorManagement ? undefined : idpChallenges),
        ...(!privateFactorManagement
          ? ssoPlugins({
              baseURL: options.baseURL,
              ...(options.sso ? { callbacks: options.sso } : {}),
              verified: samlFlow.verified,
              resolveBrowser: samlBrowser.resolve,
            })
          : []),
        ...(!privateFactorManagement ? [samlFlow.plugin] : []),
        ...(!privateFactorManagement
          ? [
              createSamlSelfLinkPlugin({
                database: db,
                baseURL: options.baseURL,
                primary: (input) => primary.selfLinkProof(input),
                nativeStart: (request): Promise<Response> => core.handler(request),
                bindStart: samlBrowser.bindStart,
              }),
            ]
          : []),
        ...(!privateFactorManagement && options.oidc ? [oidcFlow.plugin] : []),
        // Private MFA responses are forwarded only AFTER durable admission and trusted proof.
        // Framework cookie plugins would otherwise mint the browser cookie before that decision.
        ...(privateFactorManagement ? [] : (options.plugins ?? [])),
      ],
    });
  const core = build(options.allowSignup);
  currentOidcTrust = async () =>
    oidcFlow.trust(
      (await core.$context).socialProviders.find(
        (provider) => provider.id === options.oidc?.providerId,
      ),
    );
  const auth = {
    ...core,
    handler: async (request: Request) => {
      const checked = await guardSamlRequest(request);
      if (checked instanceof Response) return checked;
      try {
        return await samlBrowser.run(checked.request, checked.envelope, async () =>
          samlBrowser.bindStart(
            checked.request,
            await samlFlow.run(
              () => oidcFlow.run(() => idpChallenges.run(() => core.handler(checked.request))),
              checked.envelope,
            ),
          ),
        );
      } catch (error) {
        if (
          /\/api\/auth\/(?:callback\/|sso\/saml2\/sp\/acs\/)/.test(new URL(request.url).pathname)
        ) {
          log.error('auth.callback_failed', { errorCode: errorCode(error) });
          return Response.json(
            { code: 'SIGN_IN_UNAVAILABLE', message: 'Sign-in could not be completed.' },
            { status: 500, headers: { 'cache-control': 'no-store' } },
          );
        }
        if (new URL(request.url).pathname === '/api/auth/sign-in/sso') {
          if (error instanceof APIError && error.body?.code === 'SSO_REFUSED')
            return Response.json(
              { code: 'SSO_REFUSED', message: 'Company sign-in could not be completed.' },
              { status: 400, headers: { 'cache-control': 'no-store' } },
            );
          log.error('auth.saml_start_failed', { errorCode: errorCode(error) });
          return Response.json(
            { code: 'SIGN_IN_UNAVAILABLE', message: 'Sign-in could not be completed.' },
            { status: 500, headers: { 'cache-control': 'no-store' } },
          );
        }
        throw error;
      }
    },
  };

  /**
   * Submits a sign-in or sign-up form the way /api/auth receives it. Better Auth applies its rate limit
   * in its router, and `auth.api` goes straight to the endpoint past that, so a form calling `auth.api`
   * could be tried without limit. Going through the router means one limit and one count, whichever way
   * someone arrives. The Server Action has already had its origin checked by Next.js.
   */
  async function submitCredentials(
    form: CredentialForm,
    incoming: Headers,
  ): Promise<CredentialOutcome> {
    const headers = new Headers({
      'content-type': 'application/json',
      origin: new URL(options.baseURL).origin,
    });
    for (const name of FORWARDED_HEADERS) {
      const value = incoming.get(name);
      if (value) headers.set(name, value);
    }
    const response = await auth.handler(
      new Request(new URL(`/api/auth${form.path}`, options.baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify(form.body),
      }),
    );
    const data =
      response.status === 200
        ? ((await response
            .clone()
            .json()
            .catch(() => null)) as { twoFactorRedirect?: unknown } | null)
        : null;
    return {
      outcome: response.ok
        ? data?.twoFactorRedirect === true
          ? 'two_factor'
          : 'accepted'
        : response.status === TOO_MANY_REQUESTS
          ? 'rate_limited'
          : 'refused',
      status: response.status,
      setCookie: response.ok ? response.headers.get('set-cookie') : null,
    };
  }

  // Never mounted on any route, so sign-up stays exactly as closed as it was. The only way in here is
  // through redeemSetupToken, past a code only the operator's command can make.
  let forSetupCodes: typeof auth | undefined;

  /**
   * Makes the one account a setup code is for, and signs that person in (ID-01). The code is taken
   * first, so it cannot be used twice at once, and given back if the account could not be made.
   */
  async function redeemSetupToken(account: SetupAccount, headers: Headers): Promise<SetupOutcome> {
    const claimed = await claimSetupToken(db, account.token);
    if (!claimed) return 'invalid_token';
    try {
      forSetupCodes ??= build(true);
      await forSetupCodes.api.signUpEmail({
        body: { name: account.name, email: account.email, password: account.password },
        headers,
      });
      log.info('auth.setup_code_used');
      return 'created';
    } catch (error) {
      await releaseSetupToken(db, claimed);
      log.info('auth.setup_code_refused', { errorCode: errorCode(error) });
      return 'invalid_details';
    }
  }

  let factorManagement: typeof auth | undefined;
  const factorRouter = (request: Request) => {
    factorManagement ??= build(false, true);
    return factorManagement.handler(request);
  };
  const mfa = createMfaOperations({
    handler: factorRouter,
    managementHandler: factorRouter,
    baseURL: options.baseURL,
    enrollmentState: (userId) => readMfaEnrollmentState(db, userId),
    record: (proof) => recordSessionAssurance(db, proof),
    reserveAttempt: (userId) => reserveMfaAttempt(db, userId, MFA_ACCOUNT_LOCKOUT),
    admit: createMfaAdmission(db, options.secret),
    revoke: (userId) => revokeSessionAssurances(db, userId),
    prepareEnrollment: (input) => primary.prepareEnrollment(input),
    recordEnrollment: (input, candidate) => primary.recordEnrollment(input, candidate),
    enrollmentCurrent: (input) => primary.enrollmentCurrent(input),
    enrollmentCurrentAfterRotation: (input) => primary.enrollmentCurrentAfterRotation(input),
    completePrimaryAfterFactor: (input) => idpChallenges.complete(input),
  });
  const sso = createSsoOperations({
    baseURL: options.baseURL,
    store: (provider) => storeSsoProvider(db, provider),
    remove: (providerId) => removeSsoProvider(db, providerId),
    provider: (providerId) => readSsoProvider(db, providerId),
    verifiedSession: (input) => primary.verifiedSaml(input),
  });

  /** The sole interactive-context admission: the actual native verifier owns the cookie/session. */
  async function readInteractiveSession(headers: Headers) {
    const current = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!current || current.session.userId !== current.user.id) return null;
    const expiresAt =
      current.session.expiresAt instanceof Date
        ? current.session.expiresAt.getTime()
        : Date.parse(String(current.session.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return {
      identity: createVerifiedInteractiveIdentity({
        userId: current.user.id,
        sessionId: current.session.id,
      }),
      user: {
        id: current.user.id,
        name: current.user.name,
        email: current.user.email,
        emailVerified: current.user.emailVerified,
      },
      session: {
        id: current.session.id,
        userId: current.session.userId,
        expiresAt: current.session.expiresAt,
      },
    };
  }
  return { auth, close, mfa, redeemSetupToken, sso, submitCredentials, readInteractiveSession };
}

export type EnsemusAuth = ReturnType<typeof createAuth>['auth'];
