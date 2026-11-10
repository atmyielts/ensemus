// What every browser test stands on: one seeded organization, and pages signed in as a named person,
// each watched for unexpected destinations. App resources stay on the proxy (ADR-021); generated
// SAML tests can also use only their exact owned local HTTPS provider. Any other destination fails.
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { aClientAddress, BASE, type Person } from '../../helpers/forms';
import { buildWorld, type World } from './world';
import {
  closeGeneratedBrowserSamlProviders,
  isGeneratedBrowserSamlRequest,
} from '../../helpers/browser-saml-provider';

const ORIGIN = new URL(BASE).origin;

/** Whether a request stays with the proxy. `data:` and `blob:` URLs never reach any network. */
export function leavesTheProxy(url: string) {
  const { protocol, origin } = new URL(url);
  if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') return false;
  // A WebSocket to the proxy would have a ws origin of its own, and none is expected anyway.
  return origin !== ORIGIN;
}

/** Records all unexpected destinations and aborts requests that browser routing can intercept. */
async function guard(context: BrowserContext, outside: string[], scriptErrors: string[]) {
  const record = (value: string) => {
    const url = new URL(value);
    outside.push(`${url.origin}${url.pathname}`);
  };
  // Request events include redirects, which route handlers do not. Never exempt an arbitrary
  // external URL: the only additional destination is a live test-owned loopback IdP document.
  context.on('request', (request) => {
    if (
      leavesTheProxy(request.url()) &&
      !isGeneratedBrowserSamlRequest(request.url(), request.method(), request.resourceType())
    )
      record(request.url());
  });
  await context.route(
    (url) => leavesTheProxy(url.href),
    async (route) => {
      const request = route.request();
      if (isGeneratedBrowserSamlRequest(request.url(), request.method(), request.resourceType())) {
        await route.continue();
        return;
      }
      await route.abort();
    },
  );
  context.on('page', (page) => {
    page.on('pageerror', (error) => scriptErrors.push(error.message));
    page.on('websocket', (socket) => {
      record(socket.url());
    });
  });
}

export type OpenOptions = {
  javaScriptEnabled?: boolean;
  colorScheme?: 'light' | 'dark';
  width?: number;
  height?: number;
};

export type Open = (person: Person | null, options?: OpenOptions) => Promise<Page>;

async function addSession(context: BrowserContext, person: Person) {
  await context.addCookies(
    person.jar.cookie
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=');
        return {
          name: pair.slice(0, at),
          value: pair.slice(at + 1),
          url: ORIGIN,
          secure: true,
          httpOnly: true,
          sameSite: 'Lax' as const,
        };
      }),
  );
}

export const test = base.extend<
  { open: Open; outsideRequests: string[]; scriptErrors: string[]; generatedSamlProviders: void },
  { world: World }
>({
  generatedSamlProviders: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form here.
    async ({}, use) => {
      try {
        await use();
      } finally {
        await closeGeneratedBrowserSamlProviders();
      }
    },
    { auto: true },
  ],
  world: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form here.
    async ({}, use) => {
      const world = await buildWorld();
      await use(world);
      await world.close();
    },
    { scope: 'worker', timeout: 300_000 },
  ],

  // Tests that break something on purpose say so by emptying this list themselves.
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form here.
  scriptErrors: async ({}, use) => {
    await use([]);
  },

  outsideRequests: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form here.
    async ({}, use) => {
      await use([]);
    },
    { auto: true },
  ],

  open: async ({ browser, outsideRequests, scriptErrors }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (person, options = {}) => {
      const context = await browser.newContext({
        baseURL: BASE,
        ignoreHTTPSErrors: true,
        javaScriptEnabled: options.javaScriptEnabled ?? true,
        colorScheme: options.colorScheme ?? 'light',
        viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
        // Each browser is a client of its own, as it would be, so that the sign-in and sign-up limits
        // per address are not shared between tests.
        extraHTTPHeaders: { 'x-ensemus-test-client': aClientAddress() },
      });
      contexts.push(context);
      await guard(context, outsideRequests, scriptErrors);
      if (person) await addSession(context, person);
      const page = await context.newPage();
      return page;
    });
    await Promise.all(contexts.map((context) => context.close()));
    expect(outsideRequests, 'requests that left the proxy origin').toEqual([]);
    expect(scriptErrors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
