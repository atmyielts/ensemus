# Ensemus interface system

This is the implementation contract for every product surface. On 2026-11-06 the owner required the best possible design, named [Cal.com](https://cal.com/) as a reference, and explicitly required uniform elements and intuitive navigation for people who are not developers. Apply this alongside [experience design](03-experience-design.md), not as a separate theme for a milestone.

## Direction

A calm company workspace: clear type, neutral surfaces, restrained borders, deliberate spacing and one consistent accent. Borrow the reference's clarity and care. Ensemus's information architecture follows company work and responsibility. Product pages explain the next useful action, its consequence and its current state in ordinary language.

## Navigation and progressive disclosure

- The everyday workspace is Home, Work, Approvals, Knowledge, People and teams, Clients and Assistants. Inbox is the person's updates. Show a destination only when its working implementation and permission checks exist.
- Home starts with what needs attention. Work owns projects, tasks, deliverables, dependencies, deadlines and activity; these are views of work rather than new global navigation entries.
- Assistants is for asking for help and following outcomes. Automation Studio is a separate builder area for definitions, versions, simulations and publishing.
- Administration groups organization settings, access and security, connections, model policy, usage and budgets, billing and deployment. These are contextual settings, not competing primary workspace destinations.
- A detail page identifies its parent and provides a clear return path. Deep links retain the organization, active section and meaningful page title. The selected section remains visible for nested routes.
- Responsive navigation preserves the same labels and order. It must work with keyboard input, touch, a screen reader and JavaScript disabled. Never require hover to find a destination.
- Technical identifiers, payloads, routing decisions and diagnostic traces belong in an advanced disclosure. Show understandable names and consequences first. Permission filtering is enforced on the server and is independent of whether a link is visible.

## One source for each element

The shared implementation currently lives in `apps/web/src/app/globals.css` and `apps/web/src/components/`. Extend that system before adding a feature-specific visual convention. A separate `packages/ui` does not exist today; do not import an invented package.

| Element | Shared rule |
|---|---|
| Color | Semantic CSS tokens for background, surface, foreground, muted text, borders, accent and statuses. No feature-local palettes. |
| Typography | One self-hosted or system font family, a shared type scale and consistent heading hierarchy. No remote font dependency in Sovereign. |
| Spacing | A shared scale for gaps, padding, rows, fields and page sections. Content density can vary by documented component size. |
| Buttons and links | Shared primary, secondary, quiet and destructive variants. Links navigate; buttons act. One clearly dominant action in each decision region. |
| Forms | Visible labels, consistent field height and spacing, associated helper/error text, required/optional wording, preserved safe input and explicit pending behavior. |
| Tables and lists | Shared header, row, cell, selection, sorting, empty, loading and overflow patterns. Preserve semantic tables and readable labels on small screens. |
| Status | Shared label, icon where useful, color and tone for each meaning. Unknown delivery remains distinct from success, failure and waiting. Never rely on color alone. |
| Panels and cards | Reuse the same border, radius and padding rules. Use rows and sections for related information; a new box does not replace information hierarchy. |
| Dialogs and confirmations | Shared behavior and visual treatment, focus management, descriptive action labels and explicit consequences. Reversible routine actions should not acquire unnecessary confirmations. |
| Feedback | One convention for inline errors, validation, notifications, loading, empty and unavailable states. Unknown errors expose no internal or sensitive details. |
| Navigation | Shared section labels, active-state treatment, organization switching, back links, tabs and settings hierarchy. Feature pages do not build a second sidebar. |

States are part of the component: default, hover, focus, active, disabled, submitting, success, error, empty, unavailable and stale/conflicted where relevant. Adding a variant requires a shared API, documented purpose and migration of equivalent uses.

## Acceptance

Review representative real journeys across all milestones, not an isolated component gallery. At minimum cover Home, a work list/detail, approval, knowledge answer, assistant activity, a settings form and billing. Check light/dark, narrow/wide viewports, long names, populated/empty/error states and keyboard/no-JavaScript operation. Target WCAG 2.2 AA, including visible focus and contrast; automated checks supplement independent human accessibility review.

Before calling the design complete, inventory remaining local styles and duplicated primitives, migrate them to the shared system, inspect rendered screens and record the actual journey evidence. A guideline alone is not a completed design pass.
