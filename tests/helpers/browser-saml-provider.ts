// Test-owned real HTTPS transport: browser routing does not intercept a form's redirect target.
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';

type Response = { SAMLResponse: string; RelayState: string };
type Configuration = {
  acsURL: string;
  response: (authorizationURL: string) => Promise<Response>;
};
type GeneratedBrowserSamlProvider = {
  endpoint: string;
  origin: string;
  failures: string[];
  configure(configuration: Configuration): {
    name: string;
    value: string;
    url: string;
    secure: true;
    httpOnly: true;
    sameSite: 'None';
  };
  close(): Promise<void>;
};
const owned = new Set<GeneratedBrowserSamlProvider>();
const esc = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export async function startGeneratedBrowserSamlProvider(): Promise<GeneratedBrowserSamlProvider> {
  const pems = await generate([{ name: 'commonName', value: 'generated-browser-idp.invalid' }], {
    algorithm: 'sha256',
    keyType: 'rsa',
    keySize: 2048,
    notBeforeDate: new Date(Date.now() - 60000),
    notAfterDate: new Date(Date.now() + 86400000),
  });
  const configurations = new Map<string, Configuration>();
  const cookieName = `generated_saml_${randomUUID().replaceAll('-', '')}`;
  const failures: string[] = [];
  const server = createServer({ key: pems.private, cert: pems.cert }, (request, response) => {
    const handle = async () => {
      const url = new URL(request.url ?? '/', origin);
      if (request.method !== 'GET' || url.origin !== origin || url.pathname !== '/sign-in') {
        response.writeHead(404).end();
        return;
      }
      const token = request.headers.cookie
        ?.split('; ')
        .find((pair) => pair.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const configured = token ? configurations.get(token) : undefined;
      if (!configured) throw new Error('GENERATED_BROWSER_PROVIDER_NOT_CONFIGURED');
      const signed = await configured.response(url.href);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; img-src data:; form-action ${new URL(configured.acsURL).origin}; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,"><title>Generated company sign-in</title><main><h1>Confirm generated company sign-in</h1><form method="post" action="${esc(configured.acsURL)}"><input type="hidden" name="SAMLResponse" value="${esc(signed.SAMLResponse)}"><input type="hidden" name="RelayState" value="${esc(signed.RelayState)}"><button>Continue to Ensemus</button></form></main></html>`,
      );
    };
    void handle().catch((error: unknown) => {
      // Preserve failure without ever logging a request, assertion, private key or cookie.
      failures.push(error instanceof Error ? error.name : 'NON_ERROR_REJECTION');
      response.writeHead(500, { 'content-type': 'text/plain' }).end('Generated provider failed');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = {
    endpoint: `${origin}/sign-in`,
    origin,
    failures,
    configure(configuration: Configuration) {
      const acs = new URL(configuration.acsURL);
      if (acs.protocol !== 'https:' || acs.username || acs.password || acs.hash)
        throw new Error('GENERATED_BROWSER_ACS_INVALID');
      const token = randomUUID();
      configurations.set(token, configuration);
      return {
        name: cookieName,
        value: token,
        url: origin,
        secure: true as const,
        httpOnly: true as const,
        sameSite: 'None' as const,
      };
    },
    async close() {
      owned.delete(provider);
      configurations.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
  owned.add(provider);
  return provider;
}

/** Only the exact currently owned loopback listener and document path can pass the browser fence. */
export function isGeneratedBrowserSamlRequest(url: string, method: string, resourceType: string) {
  const parsed = new URL(url);
  return (
    method === 'GET' &&
    resourceType === 'document' &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === '/sign-in' &&
    [...owned].some((provider) => provider.origin === parsed.origin)
  );
}

export async function closeGeneratedBrowserSamlProviders() {
  const providers = [...owned];
  await Promise.all(providers.map((provider) => provider.close()));
  if (providers.some((provider) => provider.failures.length))
    throw new Error('GENERATED_BROWSER_SAML_PROVIDER_FAILED');
}
