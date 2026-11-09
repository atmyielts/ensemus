// One pass over a page as it stands: run axe, check nothing overflows sideways, and save what it looks
// like. Screenshots go under .local/screenshots, which is ignored by git.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { repoRoot } from '../../helpers/stack';

// WCAG 2.2 AA, which is every level up to and including that one.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export type Theme = 'light' | 'dark';
export const THEMES: Theme[] = ['light', 'dark'];
export const WIDTHS = [1280, 375] as const;

export type Finding = { rule: string; impact: string; where: string[]; why: string };

async function findingsOn(page: Page): Promise<Finding[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact ?? 'unknown',
    where: violation.nodes.map((node) => node.target.join(' ')),
    why: violation.nodes[0]?.failureSummary ?? violation.help,
  }));
}

/**
 * Whether the page was opened with scripting off. Such a page still answers an evaluation, but it never
 * runs a timer, and axe waits on timers, so it would wait until the test times out. The HTML parser says
 * which it is: with scripting off, what is inside `<noscript>` is parsed as elements.
 */
const scriptingOff = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div');
    probe.innerHTML = '<noscript><i></i></noscript>';
    return probe.querySelector('noscript i') !== null;
  });

/**
 * For a page opened with scripting off, axe checks an exact copy of what that page shows, at the same
 * address, width, height, theme and motion setting, in a context where axe can run. The copy is the page's
 * own document as it stands, with its `<script>` elements removed, so none of them runs, and each
 * `<noscript>` replaced by what it holds, which is what a browser with scripting off shows. Its styles and
 * images come from the proxy, as the page's own did. Nothing else is fetched.
 */
async function findingsWithScriptingOff(page: Page): Promise<Finding[]> {
  const shown = await page.evaluate(() => {
    const copy = document.documentElement.cloneNode(true) as HTMLElement;
    for (const script of copy.querySelectorAll('script')) script.remove();
    for (const fallback of copy.querySelectorAll('noscript')) {
      fallback.replaceWith(...fallback.childNodes);
    }
    return {
      html: `<!doctype html>${copy.outerHTML}`,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });
  const browser = page.context().browser();
  if (!browser) throw new Error('An accessibility check needs the browser the page runs in');
  // A request never carries the fragment, so the copy's own request is matched without one.
  const location = new URL(page.url());
  location.hash = '';
  const address = location.href;
  const origin = location.origin;
  const checking = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: page.viewportSize(),
    colorScheme: shown.dark ? 'dark' : 'light',
    reducedMotion: shown.reduced ? 'reduce' : 'no-preference',
  });
  try {
    const copy = await checking.newPage();
    await copy.route('**/*', async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.url() === address) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: shown.html,
        });
      } else if (new URL(request.url()).origin === origin) {
        await route.continue();
      } else {
        await route.abort();
      }
    });
    await copy.goto(address);
    return await findingsOn(copy);
  } finally {
    await checking.close();
  }
}

export async function axeFindings(page: Page): Promise<Finding[]> {
  return (await scriptingOff(page)) ? findingsWithScriptingOff(page) : findingsOn(page);
}

/** How far the page scrolls sideways, which is never right at any width (WCAG 1.4.10). */
export const sidewaysOverflow = (page: Page) =>
  page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return scrollWidth - clientWidth;
  });

const TILE = { 1280: 1300, 375: 1100 } as const;

/**
 * A full-page image, plus one tile per screenful for tall pages. A very tall image is scaled down to
 * nothing when viewed whole, and the tiles are what can actually be read.
 */
export async function saveLook(page: Page, state: string, label: string) {
  const directory = join(repoRoot, '.local', 'screenshots', state);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${label}.png`),
    fullPage: true,
    animations: 'disabled',
  });
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
  }));
  const tile = width >= 1000 ? TILE[1280] : TILE[375];
  if (height <= tile * 1.25) return;
  for (let part = 0; part * tile < height; part += 1) {
    await page.screenshot({
      path: join(directory, `${label}-part${part + 1}.png`),
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y: part * tile, width, height: Math.min(tile, height - part * tile) },
    });
  }
}

/** Opens every closed panel, because axe and a person's eye cannot check what is not rendered. */
export async function openPanels(page: Page) {
  return page.evaluate(() => {
    const closed = [...document.querySelectorAll('details:not([open])')];
    for (const panel of closed) panel.setAttribute('open', '');
    return closed.length;
  });
}
