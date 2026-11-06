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

export async function axeFindings(page: Page): Promise<Finding[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact ?? 'unknown',
    where: violation.nodes.map((node) => node.target.join(' ')),
    why: violation.nodes[0]?.failureSummary ?? violation.help,
  }));
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
