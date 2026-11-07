// Test-only loopback OIDC issuer with actual RSA signatures, JWKS, code/redirect/PKCE validation.
// Constructed only by explicitly run tests. No hosted credentials, private key export or global script.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
export type OidcScript = {
  subject?: string;
  email?: string;
  authTime?: number | null;
  wrongKey?: boolean;
  issuer?: string;
  audience?: string;
  nonce?: string | null;
  omitIdToken?: boolean;
  omitEmail?: boolean;
  profileSubject?: string;
  userinfoAuthTime?: number;
  expired?: boolean;
};
export async function generatedOidcIdp() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    other = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    kid = randomUUID(),
    clientId = `generated-${randomUUID()}`,
    clientSecret = `generated-${randomUUID()}`;
  const publicJwk = { ...key.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const pending = new Map<
      string,
      {
        redirect: string;
        nonce: string;
        challenge: string;
        createdAt: number;
        script: OidcScript;
        subject: string;
        email: string;
      }
    >(),
    access = new Map<string, { sub: string; email: string; auth_time?: number }>(),
    issued = new Map<string, string>();
  const requests: { method: string; path: string }[] = [];
  let issuer = '';
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  async function body(request: IncomingMessage) {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > 16384) throw new Error('GENERATED_OIDC_REQUEST_TOO_LARGE');
      parts.push(bytes);
    }
    return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer || 'http://127.0.0.1');
      requests.push({ method: request.method ?? '', path: url.pathname });
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        json(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        json(response, 200, { keys: [publicJwk] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/userinfo') {
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '',
          profile = access.get(token);
        json(
          response,
          profile ? 200 : 401,
          profile
            ? { ...profile, email_verified: true, name: 'Generated OIDC person' }
            : { error: 'invalid_token' },
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const fields = await body(request),
          code = fields.get('code') ?? '',
          item = pending.get(code),
          basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
        if (
          request.headers.authorization !== basic &&
          (fields.get('client_id') !== clientId || fields.get('client_secret') !== clientSecret)
        ) {
          json(response, 401, { error: 'invalid_client' });
          return;
        }
        if (
          !item ||
          Date.now() - item.createdAt > 120000 ||
          fields.get('grant_type') !== 'authorization_code' ||
          fields.get('redirect_uri') !== item.redirect ||
          createHash('sha256')
            .update(fields.get('code_verifier') ?? '')
            .digest('base64url') !== item.challenge
        ) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        pending.delete(code);
        const now = Math.floor(Date.now() / 1000),
          script = item.script,
          accessToken = randomUUID();
        access.set(accessToken, {
          sub: script.profileSubject ?? item.subject,
          email: item.email,
          ...(script.userinfoAuthTime === undefined ? {} : { auth_time: script.userinfoAuthTime }),
        });
        const claims = {
          iss: script.issuer ?? issuer,
          sub: item.subject,
          aud: script.audience ?? clientId,
          iat: now,
          exp: now + (script.expired ? -600 : 3600),
          ...(script.nonce === null ? {} : { nonce: script.nonce ?? item.nonce }),
          ...(script.authTime === null ? {} : { auth_time: script.authTime ?? now - 1 }),
          ...(script.omitEmail
            ? {}
            : { email: item.email, email_verified: true, name: 'Generated OIDC person' }),
        };
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString(
            'base64url',
          ),
          payload = Buffer.from(JSON.stringify(claims)).toString('base64url'),
          unsigned = `${header}.${payload}`,
          token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), script.wrongKey ? other.privateKey : key.privateKey).toString('base64url')}`;
        issued.set(code, token);
        json(response, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          ...(script.omitIdToken ? {} : { id_token: token }),
        });
        return;
      }
      json(response, 404, { error: 'unsupported_test_request' });
    })().catch(() => json(response, 400, { error: 'invalid_test_request' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('GENERATED_OIDC_LISTENER_MISSING');
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    requests,
    authorize(authorizationURL: string, script: OidcScript = {}) {
      if (pending.size >= 1000) throw new Error('GENERATED_OIDC_REQUEST_LIMIT');
      const url = new URL(authorizationURL);
      if (
        url.origin !== issuer ||
        url.pathname !== '/authorize' ||
        url.searchParams.get('client_id') !== clientId ||
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('code_challenge_method') !== 'S256'
      )
        throw new Error('GENERATED_OIDC_AUTHORIZATION_INVALID');
      const redirect = url.searchParams.get('redirect_uri'),
        nonce = url.searchParams.get('nonce'),
        challenge = url.searchParams.get('code_challenge'),
        state = url.searchParams.get('state');
      if (!redirect || !nonce || !challenge || !state)
        throw new Error('GENERATED_OIDC_BINDING_MISSING');
      const code = randomUUID(),
        subject = script.subject ?? randomUUID(),
        email = script.email ?? `generated-${randomUUID()}@example.invalid`;
      pending.set(code, {
        redirect,
        nonce,
        challenge,
        createdAt: Date.now(),
        script,
        subject,
        email,
      });
      const callback = new URL(redirect);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      callback.searchParams.set('iss', issuer);
      return { callback: callback.href, code, subject, email, nonce };
    },
    issuedToken: (code: string) => issued.get(code),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      pending.clear();
      access.clear();
      issued.clear();
    },
  };
}
