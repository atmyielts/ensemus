// UX-11: axe, at WCAG 2.2 AA, on every page and state, in light and dark, wide and narrow, with every
// panel closed and then open. Nothing is excluded. A real violation gets fixed in the app.
import { expect, test } from '../support/fixtures';
import {
  axeFindings,
  openPanels,
  saveLook,
  sidewaysOverflow,
  THEMES,
  WIDTHS,
} from '../support/look';
import { STATES } from '../support/states';

for (const state of STATES) {
  test(`${state.name} has no violations in either theme, at either width`, async ({
    open,
    world,
  }) => {
    const page = await open(state.who(world));
    const path = state.path(world);
    const response = await page.goto(path);
    // A clean scan says nothing unless it is of the state named. An error page, a 404 and the sign-in
    // page all pass axe, so each state has to show it arrived first.
    expect(response?.status(), 'status').toBe(state.status ?? 200);
    expect(new URL(page.url()).pathname, 'no redirect').toBe(new URL(path, page.url()).pathname);
    await state.then?.(page);
    for (const mark of state.shows(page)) await expect(mark.first()).toBeVisible();

    const problems: Record<string, unknown> = {};
    for (const theme of THEMES) {
      // Reduced motion, so colors have finished changing by the time axe measures them.
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
        const label = `${theme}-${width}`;
        const scan = async (suffix: string) => {
          const findings = await axeFindings(page);
          if (findings.length) problems[`${label}${suffix}`] = findings;
          const overflow = await sidewaysOverflow(page);
          if (overflow > 0) problems[`${label}${suffix} overflow`] = `${overflow}px sideways`;
          await saveLook(page, state.name, `${label}${suffix}`);
        };
        await scan('');
        if ((await openPanels(page)) > 0) {
          await scan('-open');
          await page.evaluate(() => {
            for (const panel of document.querySelectorAll('details[open]')) {
              panel.removeAttribute('open');
            }
          });
        }
      }
    }
    expect(problems).toEqual({});
  });
}
