// DOC-01: the Help pages as anyone reaches them, against built images, through the proxy. /help needs no
// sign-in, so what matters is what it cannot do: read a session, show one tenant's data to another, or
// offer a page this deployment's mode does not have (ADR-036 D5).
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_PAGES } from '../../apps/web/src/generated/guides';
import { createOrganization, type Jar, type Person, read, signUp, visit } from '../helpers/forms';

// The same default as compose.yaml, so that a run with no setting tests the mode it actually started.
const MODE = (process.env.ENSEMUS_MODE ?? 'sovereign') as 'cloud' | 'byom' | 'sovereign';
const HERE = GUIDE_PAGES.filter((page) => page.modes.includes(MODE));
const ELSEWHERE = GUIDE_PAGES.filter((page) => !page.modes.includes(MODE));

// React's spelling, so that a title holding an apostrophe is found as it was written.
const escaped = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');

/** The whole response, byte for byte, which is what "the same for everyone" has to mean. */
const bytes = async (path: string, jar?: Jar) => {
  const response = await visit(path, jar);
  expect(response.status, path).toBe(200);
  return response.text();
};

describe('the index, signed out', () => {
  it('answers without asking anyone to sign in, and starts no session', async () => {
    const response = await visit('/help');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    const { html } = await read('/help');
    expect(html).toContain('<h1>Help</h1>');
    expect(html).toContain('<title>Help | Ensemus</title>');
  });

  it.skipIf(HERE.length > 0)('says so plainly when no page has been written', async () => {
    expect((await read('/help')).html).toContain('has no help pages yet');
  });

  it.skipIf(HERE.length === 0)('links to every page of this mode', async () => {
    const { html } = await read('/help');
    expect(html).not.toContain('has no help pages yet');
    for (const page of HERE) expect(html).toContain(`href="/help/${page.slug}"`);
  });

  it.skipIf(ELSEWHERE.length === 0)('does not offer a page of another mode', async () => {
    const { html } = await read('/help');
    for (const page of ELSEWHERE) expect(html).not.toContain(`href="/help/${page.slug}"`);
  });

  it('ignores anything else in the address', async () => {
    const probe = `probe${randomUUID().replaceAll('-', '')}`;
    const { status, html } = await read(`/help?slug=../sign-in&next=https://${probe}.invalid/`);
    expect(status).toBe(200);
    expect(html).toContain('<h1>Help</h1>');
    expect(html).not.toContain(`<a href="https://${probe}`);
  });
});

describe('the same page for everyone', () => {
  const FIRST_NAME = `Help Tenant A ${randomUUID()}`;
  const SECOND_NAME = `Help Tenant B ${randomUUID()}`;
  let first: Person;
  let second: Person;
  let firstOrganization: string;
  let secondOrganization: string;
  // A page of each kind, so that this still tests something while the compiled list is empty.
  const paths = ['/help', ...HERE.slice(0, 1).map((page) => `/help/${page.slug}`)];

  beforeAll(async () => {
    first = await signUp('Avery Help');
    second = await signUp('Blake Help');
    firstOrganization = await createOrganization(first, FIRST_NAME);
    secondOrganization = await createOrganization(second, SECOND_NAME);
  });

  it.each(paths)('%s has the same bytes for two tenants and for nobody', async (path) => {
    const [forFirst, forSecond, forNobody] = [
      await bytes(path, first.jar),
      await bytes(path, second.jar),
      await bytes(path),
    ];
    expect(forFirst).toBe(forSecond);
    expect(forFirst).toBe(forNobody);
  });

  it.each(paths)('%s holds nothing of either tenant', async (path) => {
    for (const jar of [first.jar, second.jar]) {
      const page = await bytes(path, jar);
      for (const value of [
        FIRST_NAME,
        SECOND_NAME,
        first.name,
        second.name,
        first.email,
        second.email,
        firstOrganization,
        secondOrganization,
      ]) {
        expect(page).not.toContain(value);
      }
    }
  });

  it.each(paths)('%s takes no notice of a session that is not real', async (path) => {
    const forged = await bytes(path, {
      cookie: `__Secure-better-auth.session_token=${randomUUID()}`,
    });
    expect(forged).toBe(await bytes(path));
  });

  it('is linked from the navigation of both tenants, at one address outside either', async () => {
    for (const [person, organization] of [
      [first, firstOrganization],
      [second, secondOrganization],
    ] as const) {
      const { html } = await read(`/o/${organization}`, person.jar);
      const labels = [...html.matchAll(/<a\b[^>]*\shref="\/help"[^>]*>([\s\S]*?)<\/a>/g)].map(
        ([, contents]) => contents!.replace(/<[^>]*>/g, '').trim(),
      );
      expect(labels).toContain('Help');
    }
  });
});

describe('a way in for someone who cannot sign in', () => {
  it('is on the sign-in page', async () => {
    expect((await read('/sign-in')).html).toMatch(/<a[^>]*href="\/help"[^>]*>Help/);
  });
});

describe('what /help does not have', () => {
  // Each keeps its encoding on the way through fetch. A plain ../ would be resolved by URL parsing
  // before it left, and would not test the route at all.
  it.each([
    '/help/never-written',
    '/help/APPROVALS',
    '/help/..%2fsign-in',
    '/help/..%2Fsign-in',
    '/help/%2e%2e%2fsign-in',
    '/help/%252e%252e%252fsign-in',
    '/help/..%5csign-in',
    '/help/__proto__',
    '/help/constructor',
    '/help/approvals/extra',
  ])('%s is the 404 anything else gets', async (path) => {
    const { status, html } = await read(path);
    expect(status).toBe(404);
    expect(html).toContain('Page not found');
    expect(html).not.toContain('<h1>Help</h1>');
  });

  it('gives the same 404 to someone signed in', async () => {
    const person = await signUp('Casey Help');
    const { status, html } = await read('/help/never-written', person.jar);
    expect(status).toBe(404);
    expect(html).toContain('Page not found');
  });

  // Billing is for Cloud and BYOM. The check is against the page's name, so that it holds whether or not
  // the page has been written yet: Sovereign must not have one either way.
  it.runIf(MODE === 'sovereign')('has no billing page in Sovereign', async () => {
    const { status, html } = await read('/help/billing-and-invoices');
    expect(status).toBe(404);
    expect(html).toContain('Page not found');
    expect(html).not.toContain('Billing and invoices');
  });

  it.skipIf(ELSEWHERE.length === 0)('answers 404 for every page of another mode', async () => {
    for (const page of ELSEWHERE) {
      const { status, html } = await read(`/help/${page.slug}`);
      expect(status, page.slug).toBe(404);
      expect(html, page.slug).not.toContain(`<h1>${escaped(page.title)}</h1>`);
    }
  });
});

describe('a written page', () => {
  it.skipIf(HERE.length === 0)('shows its title, once, as the only h1', async () => {
    for (const page of HERE) {
      const { status, html } = await read(`/help/${page.slug}`);
      expect(status, page.slug).toBe(200);
      expect(html, page.slug).toContain(`<h1>${escaped(page.title)}</h1>`);
      expect(html.match(/<h1\b/g), page.slug).toHaveLength(1);
      expect(html, page.slug).toContain(`<title>${escaped(page.title)} | Ensemus</title>`);
    }
  });

  it.skipIf(HERE.every((page) => page.status !== 'written_untested'))(
    'keeps the banner of an untested page, straight after the title',
    async () => {
      for (const page of HERE.filter((one) => one.status === 'written_untested')) {
        const { html } = await read(`/help/${page.slug}`);
        expect(html, page.slug).toMatch(
          /<h1>[^<]*<\/h1><div class="guide"><blockquote><strong>Not yet tested end to end\.<\/strong>/,
        );
      }
    },
  );

  it.skipIf(HERE.length === 0)('links only to other help pages and to itself', async () => {
    for (const page of HERE) {
      const { html } = await read(`/help/${page.slug}`);
      const guide = /<div class="guide">[\s\S]*?<\/article>/.exec(html)?.[0] ?? '';
      expect(guide, page.slug).not.toBe('');
      for (const [, href] of guide.matchAll(/<a\b[^>]*href="([^"]*)"/g)) {
        expect(href, page.slug).toMatch(/^(\/help(\/[a-z0-9-]+)?(#[\w-]+)?|#[\w-]+)$/);
      }
    }
  });
});
