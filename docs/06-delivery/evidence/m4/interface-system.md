# Shared interface system — M4 implementation

The owner’s contract is `docs/01-product/07-interface-system.md` in the main checkout. This pass applies its shared visual language and navigation to the currently implemented product. It does not claim that unimplemented Knowledge, billing, daily assistant conversations or full Studio authoring are finished.

## Audit and direction

The existing shared CSS and components already supplied useful offline fonts, theme tokens, semantic buttons/forms, visible focus, safe error copy and native confirmation panels. The real built Home page was inspected before the visual changes; `output/playwright/ensemus-home-before.png` records that baseline. The [Cal.com reference](https://cal.com/) was inspected in a browser and captured as `output/playwright/cal-reference.png` and `cal-workspace-reference.png`. The direction takes its clear type, neutral surfaces, restrained borders and strong action hierarchy. Ensemus keeps its own company-work structure and semantic status colors.

Concrete findings addressed:

| Finding | Change |
| --- | --- |
| Eleven flat destinations mix daily work, agent building and safety/budget administration. | Six Workspace destinations, one Automation Studio entry and one Administration entry, filtered by current capabilities. |
| `/agents` has no page. | A real Studio overview links to the functioning version registry at `/settings/agents`. Route-existence tests cover every advertised destination. |
| External actions competes with approval requests as another global section. | Approvals owns contextual Review requests and External actions links and remains selected on either detail route. |
| Mobile wraps the whole flat navigation above the content. | A native, keyboard-operable Workspace menu preserves the same labels/order and works without scripts. Client navigation closes it and returns focus to its summary while the next page loads. |
| Settings are scattered globally without an overview or return path. | Administration groups only working access, connections, models, budgets and safety pages. Shared workspace location links return from nested routes. |
| Nine local inline styles duplicate shared layout/spacing conventions. | Migrated them to shared utilities in existing work, approval, invite and registry components. The standalone global-error fallback intentionally retains its inline sizing so it remains usable if app CSS fails. |
| An interim `budget.view` navigation check is not a real capability. | Navigation uses the actual `usage.view` / `budget.manage` permissions. Destinations independently authorize on the server. |

No mock button, future link, remote font, external asset, new package or feature-specific color palette was introduced.

## Shared implementation

- `apps/web/src/app/globals.css`: semantic light/dark colors, neutral action hierarchy, spacing/type/radius/motion/control-height tokens, shared form/list/table/panel/notice/status rules and responsive shell. Existing feature classes remain compatible with those rules.
- `components/ui.tsx`: existing PageHead, Empty, ErrorNotice, StatusBadge and formatting helpers plus shared ActionLink, BackLink and DestinationList. Domain-specific status descriptions may differ with business meaning; the badge, tone, spacing and feedback primitives remain shared.
- `components/navigation-model.ts`: the single list of implemented destinations, capability visibility and section matching for nested routes; used by desktop/mobile/context and the Administration index. No tenant content is globally cached.
- `components/main-nav.tsx` and `navigation-icon.tsx`: identical desktop/mobile links, local outline icons, live pending text, selected location and native mobile disclosure. HTML links remain ordinary links when JavaScript is disabled.
- `/settings`: server-authorized organization controls, described as consequences in ordinary language.
- `/studio`: server-authorized real publication overview, version history and model/budget preparation. Publishing links reach the existing functioning form. This is not a claim that the later graphical authoring/simulation milestone exists.

## Component conventions

| Element | Shared API/convention | States and access |
| --- | --- | --- |
| Primary action | `ActionLink` or the existing SubmitButton / `.button` | Neutral solid action; visible focus; ordinary link or submit behavior; pending/disabled stays explicit. |
| Secondary action | `ActionLink variant="secondary"` / `.secondary` | Neutral outline. Existing `.quiet` remains a compatibility alias for the same outline treatment. |
| Quiet action | `ActionLink variant="quiet"` / `.ghost` | Transparent surface and visible hover/focus; preserves link semantics. |
| Destructive action | ConfirmForm / `.danger` | Explicit consequence and existing native confirmation behavior; no new confirmation on routine reversible work. |
| Fields | Visible label, existing kept-field behavior, shared control height/border/spacing | Error and helper text stay associated by existing field APIs; validation/pending behavior unchanged. |
| Empty state | `Empty`, optional `title` and real `action` | Explains the next useful step rather than an empty panel. |
| Settings destination | `DestinationList` | Entire named row is a real link, description explains consequence, outline icon is decorative. |
| Status | StatusBadge / shared badge tones | Text always accompanies color; unknown delivery retains a separate tone and explicit wording. |
| Detail return | BackLink / workspace location | Organization and section preserved; deep links keep a functioning parent route. |

Spacing tokens use the 4/8/12/16/20/24/32/40/48px scale. Controls are 40px on desktop and 44px on narrow screens. System fonts work offline. Reduced-motion users get no optional transition. Focus outlines remain explicit; semantic tables and their existing small-screen presentation are preserved.

Equivalent component migration is additive: reuse these primitives/tokens before adding another feature convention. Existing CSS aliases preserve functioning routes during later milestone integration. The low-level global error page is a deliberate standalone fallback, not a second application style system.

## Verification and remaining rendered gate

Executed locally for this pass: 12 navigation tests passed; web TypeScript passed; browser TypeScript passed; scoped ESLint and diff checks passed. The navigation tests verify real route existence, role filtering, correct active section on deep links, segment boundaries and organization isolation in the navigation model. These checks do not replace page authorization or visual acceptance.

`tests/browser/specs/interface-system.spec.ts` is written and typechecked. Root owns the actual built-image browser run. It covers:

1. Light and dark at 320, 768, 1024 and 1440px: Home, work list, long work detail, approval, Administration, Models, budgets and Studio. Each requires a successful real response, one page title, no sideways overflow, WCAG 2.2 AA axe findings empty and saved screenshots.
2. Native mobile menu with keyboard/JavaScript disabled, through Administration to Models.
3. Ordinary members see workspace links and get 404 for privileged Administration/Studio deep links.

Reproduction on the isolated M4 test stack:

```powershell
$env:ENSEMUS_TEST_BASE = 'https://localhost:19443'
# Set ENSEMUS_TEST_PG_PORT to that stack's published database port as root's gate does.
pnpm --filter @ensemus/browser-tests test specs/interface-system.spec.ts
```

The rebuilt-image render review and these browser results must be added before accepting this design pass. Human review of accessibility, dense populated states and later Knowledge/billing/assistant journeys remains necessary; automated screenshots or a guideline alone are not full design acceptance.
