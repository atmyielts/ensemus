// What a page itself says, as opposed to what the framework adds around it. Next renders its route
// announcer as an empty `role="alert"` region outside `main` on every page with scripts, so an unscoped
// alert locator finds two elements there and one without scripts. The page's own notices are in `main`.
import type { Page } from '@playwright/test';

/** The page's own alert: a refusal or an error it shows. Never the route announcer. */
export const alertIn = (page: Page) => page.getByRole('main').getByRole('alert');
