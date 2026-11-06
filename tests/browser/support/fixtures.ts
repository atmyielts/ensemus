// What every browser test stands on: one seeded organization, and pages signed in as a named person,
// each watched for anything leaving the proxy's origin. The app loads nothing from outside (ADR-021),
// so any such request fails the test that caused it.
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { BASE, type Person } from '../../helpers/forms';
import { buildWorld, type World } from './world';

const ORIGIN = new URL(BASE).origin;

/** Whether a request stays with the proxy. `data:` and `blob:` URLs never reach any network. */
export function leavesTheProxy(url: string) {
  const { protocol, origin } = new URL(url);
  if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') return false;
  // A WebSocket to the proxy would have a ws origin of its own, and none is expected anyway.
  return origin !== ORIGIN;
}

/** Sends the guard's findings to one list. Anything headed outside is stopped as well as recorded. */
async function guard(context: BrowserContext, outside: string[]) {
  await context.route(
    (url) => leavesTheProxy(url.href),
    async (route) => {
      outside.push(route.request().url());
      await route.abort();
    },
  );
  context.on('page', (page) => {
    page.on('websocket', (socket) => {
      outside.push(socket.url());
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
  { open: Open; outsideRequests: string[]; scriptErrors: string[] },
  { world: World }
>({
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
      });
      contexts.push(context);
      await guard(context, outsideRequests);
      if (person) await addSession(context, person);
      const page = await context.newPage();
      page.on('pageerror', (error) => scriptErrors.push(error.message));
      return page;
    });
    await Promise.all(contexts.map((context) => context.close()));
    expect(outsideRequests, 'requests that left the proxy origin').toEqual([]);
    expect(scriptErrors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
