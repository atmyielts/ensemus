---
title: Accessibility
audience: user
area: admin
tickets: [OPS-05]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [tests/browser/specs/accessibility.spec.ts, tests/browser/specs/keyboard.spec.ts, tests/browser/specs/no-javascript.spec.ts, tests/browser/support/states.ts, tests/browser/support/look.ts, .github/workflows/ci.yml, apps/web/src/app/globals.css, apps/web/src/app/o/[organizationId]/layout.tsx, docs/06-delivery/06-end-to-end-delivery-plan.md]
tests: []
---

# Accessibility

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This page says what has been checked and what has not. No independent accessibility audit has happened yet.

## What has been tested

These are automated tests in a real browser. They passed in the project's automated build on the core pages as they stood when this page was written. A pass covers the version it ran on, and does not carry over to later ones.

- **Automated page checks.** A tool called axe checks each page state against the rules it has for WCAG 2.2 levels A and AA, and each state is also checked for sideways scrolling. Each one runs in the light and dark themes, at a wide and a phone-sized width, with panels closed and then open.
- **Keyboard only.** With no mouse, a person can sign in and approve an approval, open the deny panel and deny, and sign up and create an organization. **Skip to content** is the first stop on a page. Focus stays visible on the way through those tasks, and on the main pages it can be walked through and back out in both directions.
- **No JavaScript.** With scripts off, a person can sign up, create an organization, sign out and back in, create and move work, stop work, add a file, decide an approval and filter by status.

The page checks cover these pages and their main states: sign-in, sign-up, setup code, Home, work lists and work detail, approvals, people, clients, inbox, invitations, and page not found.

## What has not been tested

- **An independent audit.** Nobody outside the project has reviewed the product for accessibility.
- **Screen readers.** No pass with a real screen reader has been recorded.
- **Real participants.** No usability study with real people has been recorded.
- **Everything not listed above.** A page added after those tests, or left off that list, has not been through them.

An automated tool finds only some problems. A pass does not show that a page is easy to use with assistive technology. This page does not say that Ensemus is compliant with WCAG or any other standard. <!-- not-a-claim -->

## What you can use today

- Press Tab on any organization page, and the first stop is **Skip to content**.
- Ensemus follows your device's light or dark setting, and its reduced motion setting.
- The tasks listed under **No JavaScript** work with scripts off.

## What it cannot do

Ensemus has no accessibility settings page, and no other format of its pages. No page says how to ask for one.

## If something gets in your way

Tell an owner or admin of your organization, or use the contact in [Getting support](support.md). Say which page you were on, what you were using, such as a screen reader or the keyboard alone, and what stopped you. Ensemus has no form for this yet.

## Where modes differ

The pages are the same in all three modes, and so is this page.
