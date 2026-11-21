// DOC-01: what /help will show, and what it refuses, with pages injected, because the compiled list holds
// nothing until the guides are written. Run here, because the web app has no test runner of its own. The
// routes themselves are read in tests/stack/help.test.ts and tests/browser/specs/help.spec.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuideBlocks } from '../../apps/web/src/components/guide-blocks';
import {
  GUIDE_PAGES,
  type GuideBlock,
  type GuidePage,
  type GuideSection,
} from '../../apps/web/src/generated/guides';
import {
  blocksFor,
  headingsOf,
  hrefOf,
  pageFor,
  pagesFor,
  sectionsFor,
} from '../../apps/web/src/lib/guides';
import { repoRoot } from '../helpers/stack';

// React belongs to the web app, not to the test package, so it is found from there.
const { renderToStaticMarkup } = createRequire(join(repoRoot, 'apps/web/package.json'))(
  'react-dom/server',
) as { renderToStaticMarkup: (node: unknown) => string };

const render = (blocks: readonly GuideBlock[]) => renderToStaticMarkup(GuideBlocks({ blocks }));
const text = (v: string) => ({ t: 'text', v }) as const;

const BANNER =
  'This page was written from the code, and nobody has followed it on a running system yet.';

const page = (slug: string, overrides: Partial<GuidePage> = {}): GuidePage => ({
  slug,
  title: `Title of ${slug}`,
  section: 'work',
  modes: ['cloud', 'byom', 'sovereign'],
  status: 'written_untested',
  blocks: [],
  ...overrides,
});

const approvals = page('approvals');
const billing = page('billing-and-invoices', { section: 'admin', modes: ['cloud', 'byom'] });
const cloudOnly = page('cloud-only', { section: 'admin', modes: ['cloud'] });
const home = page('home', { section: 'start' });
const pages = [approvals, billing, cloudOnly, home];

const sections: readonly GuideSection[] = [
  { id: 'start', title: 'Getting started' },
  { id: 'work', title: 'Work and approvals' },
  { id: 'nothing', title: 'A section with no pages' },
  { id: 'admin', title: 'Your organization' },
];

describe('which pages a mode has', () => {
  it('lists what applies to the mode, and nothing else', () => {
    expect(pagesFor('cloud', pages)).toEqual(pages);
    expect(pagesFor('byom', pages)).toEqual([approvals, billing, home]);
    expect(pagesFor('sovereign', pages)).toEqual([approvals, home]);
  });

  it('has nothing to list when no page is compiled in', () => {
    expect(pagesFor('sovereign', [])).toEqual([]);
    expect(pageFor('approvals', 'sovereign', [])).toBeUndefined();
    expect(sectionsFor('sovereign', sections, [])).toEqual([]);
  });

  it('reads the compiled list by default', () => {
    expect(pagesFor('cloud')).toEqual(GUIDE_PAGES.filter((one) => one.modes.includes('cloud')));
  });

  it('finds a page by its exact slug', () => {
    expect(pageFor('approvals', 'sovereign', pages)).toBe(approvals);
  });

  it('answers the same for a page of another mode as for no page at all', () => {
    expect(pageFor('cloud-only', 'cloud', pages)).toBe(cloudOnly);
    expect(pageFor('cloud-only', 'sovereign', pages)).toBeUndefined();
    expect(pageFor('cloud-only', 'byom', pages)).toBeUndefined();
    expect(pageFor('billing-and-invoices', 'sovereign', pages)).toBeUndefined();
    expect(pageFor('never-written', 'sovereign', pages)).toBeUndefined();
  });

  // Each is what an address could carry. The slug is compared as it came, and never decoded or joined.
  it.each([
    '',
    ' ',
    'unknown',
    'APPROVALS',
    'approvals/',
    '/approvals',
    'approvals ',
    'approvals\n',
    'approvals#x',
    'approvals?x=1',
    './approvals',
    '../approvals',
    '../../etc/passwd',
    '..\\approvals',
    '..%2fapprovals',
    '..%2Fapprovals',
    '%2e%2e%2fapprovals',
    '%2E%2E/approvals',
    '%252e%252e%252fapprovals',
    '%61pprovals',
    'approvals%00',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
  ])('does not find %j', (slug) => {
    expect(pageFor(slug, 'cloud', pages)).toBeUndefined();
  });
});

describe('the index', () => {
  it('keeps the order of the sections, and offers no section with nothing to read', () => {
    const titles = (mode: GuidePage['modes'][number]) =>
      sectionsFor(mode, sections, pages).map(({ section, pages: inside }) => [
        section.id,
        inside.map((one) => one.slug),
      ]);
    expect(titles('cloud')).toEqual([
      ['start', ['home']],
      ['work', ['approvals']],
      ['admin', ['billing-and-invoices', 'cloud-only']],
    ]);
    // Your organization has only billing in it here, so a Sovereign deployment has no such heading.
    expect(titles('sovereign')).toEqual([
      ['start', ['home']],
      ['work', ['approvals']],
    ]);
  });
});

describe('where a guide can link', () => {
  it.each([
    ['approvals', '/help/approvals'],
    ['approvals#x', '/help/approvals#x'],
    ['sent-failed-unknown#why-it-says-unknown', '/help/sent-failed-unknown#why-it-says-unknown'],
    ['#on-this-page', '#on-this-page'],
  ])('takes %j to %j', (link, href) => {
    expect(hrefOf(link)).toBe(href);
  });

  // None of these can be written in a guide, because check-guides.mjs refuses them. This is the second
  // lock: if one reached the compiled module anyway, it still could not leave the guides.
  it.each([
    '',
    '#',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'javascript:alert(1)#x',
    'approvals#x" onclick="alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'https://outside.example.invalid',
    'https:outside.example.invalid',
    'HTTP://outside.example.invalid/approvals',
    '//outside.example.invalid',
    '\\\\outside.example.invalid',
    '/\\outside.example.invalid',
    '/approvals',
    '/o/00000000-0000-4000-8000-000000000000',
    '../sign-in',
    '../../api/auth/session',
    '..%2fsign-in',
    '%2e%2e%2fsign-in',
    'approvals/../../sign-in',
    'approvals?next=https://outside.example.invalid',
    'approvals#x#y',
    'approvals\n',
    'Approvals',
  ])('sends %j nowhere but the index', (link) => {
    expect(hrefOf(link)).toBe('/help');
  });

  it('can reach every page that is compiled in', () => {
    for (const { slug } of GUIDE_PAGES) expect(hrefOf(slug)).toBe(`/help/${slug}`);
  });
});

describe('a link to a page this mode does not have', () => {
  const link = (href: string) => ({ t: 'link', v: 'Read this', href }) as const;
  const blocks: readonly GuideBlock[] = [
    { b: 'p', inline: [link('billing-and-invoices')] },
    { b: 'ul', items: [[link('billing-and-invoices#x')], [link('approvals')]] },
    {
      b: 'table',
      head: [[link('cloud-only')]],
      rows: [[[link('billing-and-invoices')], [link('home#y')], [link('#here')]]],
    },
  ];
  const shown = (mode: GuidePage['modes'][number]) =>
    render(blocksFor(page('here', { blocks }), mode, pages));

  it('becomes plain text, so nobody follows it to a dead end', () => {
    const html = shown('sovereign');
    expect(html).not.toContain('billing-and-invoices');
    expect(html).not.toContain('cloud-only');
    // Every one of the seven is still there to read, whether or not it can be followed.
    expect(html.match(/Read this/g)).toHaveLength(7);
    expect(html).toContain('href="/help/approvals"');
    expect(html).toContain('href="/help/home#y"');
    expect(html).toContain('href="#here"');
  });

  it('stays a link in a mode that has the page', () => {
    const html = shown('cloud');
    expect(html).toContain('href="/help/billing-and-invoices"');
    expect(html).toContain('href="/help/billing-and-invoices#x"');
    expect(html).toContain('href="/help/cloud-only"');
  });

  it('becomes plain text when it could never be followed at all', () => {
    const html = render(
      blocksFor(
        page('here', { blocks: [{ b: 'p', inline: [link('javascript:alert(1)')] }] }),
        'cloud',
        pages,
      ),
    );
    expect(html).toBe('<div class="guide"><p>Read this</p></div>');
  });
});

describe('how a guide renders', () => {
  const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';

  it.each<[string, GuideBlock]>([
    ['a heading', { b: 'h', level: 2, inline: [text(hostile)] }],
    ['a paragraph', { b: 'p', inline: [text(hostile)] }],
    ['a quote', { b: 'quote', inline: [text(hostile)] }],
    ['strong text', { b: 'p', inline: [{ t: 'strong', v: hostile }] }],
    ['inline code', { b: 'p', inline: [{ t: 'code', v: hostile }] }],
    ['the words of a link', { b: 'p', inline: [{ t: 'link', v: hostile, href: 'approvals' }] }],
    ['a list', { b: 'ul', items: [[text(hostile)]] }],
    ['a numbered list', { b: 'ol', items: [[text(hostile)]] }],
    ['a code block', { b: 'code', lang: 'html', text: hostile }],
    ['a table', { b: 'table', head: [[text(hostile)]], rows: [[[text(hostile)]]] }],
  ])('shows markup in %s as text', (_, block) => {
    const html = render([block]);
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not let the language of a code block reach the page', () => {
    const html = render([{ b: 'code', lang: '"><script>alert(1)</script>', text: 'pnpm install' }]);
    expect(html).toBe('<div class="guide"><pre><code>pnpm install</code></pre></div>');
  });

  it.each([
    'javascript:alert(1)',
    'https://outside.example.invalid',
    '//outside.example.invalid',
    '../sign-in',
  ])('never writes the link %j into the page', (href) => {
    const html = render([{ b: 'p', inline: [{ t: 'link', v: 'Read this', href }] }]);
    expect(html).toContain('href="/help"');
    expect(html).not.toContain(href);
  });

  it('shows the banner of an untested page first, in its own words', () => {
    const blocks: readonly GuideBlock[] = [
      {
        b: 'quote',
        inline: [{ t: 'strong', v: 'Not yet tested end to end.' }, text(` ${BANNER}`)],
      },
      { b: 'h', level: 2, inline: [text('What you can do')] },
    ];
    const html = render(blocksFor(page('here', { blocks }), 'sovereign', pages));
    expect(html.indexOf('<blockquote')).toBe('<div class="guide">'.length);
    expect(html).toContain(`<strong>Not yet tested end to end.</strong> ${BANNER}`);
    expect(html.indexOf(BANNER)).toBeLessThan(html.indexOf('What you can do'));
  });

  it('renders each kind of block as its own element', () => {
    const html = render([
      { b: 'p', inline: [text('Before '), { t: 'code', v: 'pnpm' }] },
      { b: 'ol', items: [[text('One')], [text('Two')]] },
      { b: 'table', head: [[text('Who')]], rows: [[[{ t: 'strong', v: 'Owner' }]]] },
    ]);
    expect(html).toContain('<p>Before <code>pnpm</code></p>');
    expect(html).toContain('<ol><li>One</li><li>Two</li></ol>');
    expect(html).toContain(
      '<table><thead><tr><th scope="col">Who</th></tr></thead>' +
        '<tbody><tr><td><strong>Owner</strong></td></tr></tbody></table>',
    );
  });
});

describe('the headings of a guide', () => {
  const heading = (level: number, v: string): GuideBlock => ({
    b: 'h',
    level,
    inline: [{ t: 'text', v }],
  });

  it('starts at level 2, because the title of the page is its only h1', () => {
    const html = render([heading(1, 'Too high'), heading(2, 'Right'), heading(6, 'Too low')]);
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2 id="too-high">Too high</h2>');
    expect(html).toContain('<h2 id="right">Right</h2>');
    expect(html).toContain('<h3 id="too-low">Too low</h3>');
  });

  it('never skips a level', () => {
    const levels = headingsOf([heading(3, 'First'), heading(3, 'Second'), heading(2, 'Third')]);
    expect(levels.map((one) => one?.level)).toEqual([2, 3, 2]);
  });

  it('skips what is not a heading, and keeps its place in the list', () => {
    const found = headingsOf([{ b: 'p', inline: [] }, heading(2, 'Here')]);
    expect(found).toEqual([undefined, { level: 2, id: 'here' }]);
  });

  it('gives a heading the address a link to it would use', () => {
    const ids = headingsOf([
      heading(2, 'Why it says “unknown”'),
      heading(2, 'What you’ll see'),
      heading(2, '  Sent,   failed & unknown  '),
      { b: 'h', level: 2, inline: [{ t: 'code', v: 'Work_Units' }, text(' now')] },
    ]).map((one) => one?.id);
    expect(ids).toEqual([
      'why-it-says-unknown',
      'what-youll-see',
      'sent-failed-unknown',
      'work_units-now',
    ]);
    for (const id of ids) expect(hrefOf(`approvals#${id as string}`)).toContain('#');
  });

  it('never gives two headings one address', () => {
    const ids = headingsOf([
      heading(2, 'Before you start'),
      heading(2, 'Before you start'),
      heading(2, 'Before you start'),
      heading(2, 'Before you start 1'),
    ]).map((one) => one?.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(0, 3)).toEqual(['before-you-start', 'before-you-start-1', 'before-you-start-2']);
  });

  it('gives no address to a heading with no letters it could use', () => {
    expect(headingsOf([heading(2, '“…”')])[0]).toEqual({ level: 2, id: undefined });
    expect(render([heading(2, '“…”')])).toBe('<div class="guide"><h2>“…”</h2></div>');
  });
});

describe('what the routes are allowed to touch', () => {
  const source = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
  const routes = ['apps/web/src/app/help/page.tsx', 'apps/web/src/app/help/[slug]/page.tsx'];
  const parts = [...routes, 'apps/web/src/components/guide-blocks.tsx', 'apps/web/src/lib/guides.ts'];

  it.each(parts)('%s renders no raw HTML', (path) => {
    // Named in two pieces so that this file does not itself hold what a search would look for.
    expect(source(path)).not.toContain(['dangerously', 'SetInnerHTML'].join(''));
  });

  // These read the code, because a route that read a session would still pass every test of its output
  // until someone's name appeared in it.
  it.each(routes)('%s reads no session, no tenant and no input but the slug', (path) => {
    const code = source(path);
    for (const name of [
      'requireTenant',
      'requireActor',
      'getSession',
      'withTenantTx',
      'next/headers',
      '@ensemus/database',
      '@ensemus/application',
      '@ensemus/auth',
      'searchParams',
    ]) {
      expect(code, name).not.toContain(name);
    }
    expect(code).toContain('getRuntime().config.mode');
  });

  it('keeps the logic free of the server, so that it is the logic these tests ran', () => {
    expect(source('apps/web/src/lib/guides.ts')).not.toContain('server-only');
    expect(source('apps/web/src/lib/guides.ts')).not.toMatch(/process\.env|@\/server/);
  });

  it('turns the slug away before anything renders, on the page and in its title', () => {
    const code = source('apps/web/src/app/help/[slug]/page.tsx');
    expect(code).toContain('notFound()');
    expect(code).not.toMatch(/decodeURI/);
  });
});
