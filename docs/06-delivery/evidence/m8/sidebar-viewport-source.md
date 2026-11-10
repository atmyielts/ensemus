# Sidebar viewport source fix

Scope: shared interface system / UX-11. Source base: root `27ada85`, branch `codex/sidebar-viewport`.

## Observed baseline

Read the actual root capture `output/playwright/m8-home-desktop.png` (1440×1000). Its expanded Home and Account groups place the account footer at the lower edge; the long generated email wraps to three lines, and Sign out falls below the capture. The current whole-sidebar scroll is the wrong scroll boundary for persistent brand/account controls.

## Source changes

- Only sidebar/navigation/footer CSS changes: sticky viewport-height desktop flex column; nonshrinking brand and footer; `min-height: 0` and an independent navigation scroller. Token-based internal padding preserves focus-outline space and existing link alignment. No destination, main content, color or typography redesign.
- Account name/email visually truncate to one line. Actual full text remains in the DOM; the email also has its full address in `title`.
- The existing mobile grid returns to `height: auto`, keeping its native disclosure and current compact footer behavior. Existing dark tokens and shared spacing remain in use.
- The only shell markup change is the email title. Home's outcome destination and favicon remain root-owned.

## Authored verification

`tests/browser/specs/sidebar-viewport.spec.ts` has four light/dark × JavaScript/no-JavaScript journeys using an actual generated long name/email and company. Each checks actual expanded Home and Work states at 1440×720, full brand/footer/Sign out bounds, inner navigation scrolling, retained full email/title, keyboard navigation from the final destination through account and Sign out, no horizontal overflow, and the mobile native disclosure after resizing. JavaScript cases also run axe.

## Actual checks

Executed in the coordinated tiny source slot:

- `node node_modules/prettier/bin/prettier.cjs --write` for the sidebar CSS, organization layout and new browser test: passed.
- `node node_modules/eslint/bin/eslint.js --max-warnings 0` for the organization layout and new browser test: passed.
- `pnpm exec tsc --noEmit -p tests/browser/tsconfig.json`: passed.
- `pnpm --filter @ensemus/web typecheck`: route generation and TypeScript passed.

The slot was explicitly released after the final type command. The actual baseline screenshot was inspected; the changed layout has not been rendered or browser-qualified. All four authored journeys remain unrun. No database, install, build or browser execution was performed for this follow-up.
