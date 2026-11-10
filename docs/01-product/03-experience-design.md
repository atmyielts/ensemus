# UX, information architecture, and interface quality

## Experience thesis

Ensemus should feel like a calm, beautiful, responsive operating environment that **removes coordination work**. It must not appear as a technical console for nontechnical employees. Minimize visual noise, avoid fake AI theatrics, and keep the system's limitations visible without overwhelming users.

## Top-level navigation

- **Home:** My attention, today, waiting approvals, work updates, optional company pulse depending on role.
- **Work:** Work Units, projects, lists, boards, calendar, dependencies, milestones, deliverables.
- **People & Teams:** Directory, responsibilities, team structure; permission-filtered.
- **Clients & Relationships:** Accounts, external parties, linked work, commitments.
- **Knowledge:** Search, collections, sources, documents, citations, memory review.
- **Assistants:** My assistant, team assistants, delegated runs, outcomes, capabilities.
- **Automation Studio:** Admin/authorized builder only; agents, skills, workflows, simulation, versions.
- **Administration:** Organization, security, model policies, integrations, budgets, billing, deployment.

## Main role-aware home

One concise priorities region, an attention queue grouped by urgency, active work summary, human/AI handoffs, and optional organizational signals. Prioritize information by reversibility and impact, not by arbitrary feed activity. Users must be able to dismiss, snooze, or explain alerts. Company Pulse has evidence-linked drilldown and never presents speculative causal claims as facts.

## Primary design patterns

**Outcome composer:** Natural-language objective converted into a structured Work Unit preview. Display owner, due date, success criteria, dependencies, suggested workflow and whether AI will access external data. Nothing runs until authorized.

**Work Unit detail:** Purpose → accountable owner → current state → dependencies → relevant source material → progress → actions → final artifact → verification. Deep agent traces live behind advanced inspect controls.

**Agent activity:** Human-readable timeline (e.g. "Reading approved account brief", "Preparing draft", "Waiting for legal approval"), clear stop/pause action, cost/usage indicator, and sources. Never surface internal chain-of-thought.

**Knowledge answer:** Evidence snippets/citations, freshness, access indicators, uncertainty labels, and obvious path to original material.

**Approval center:** Exact before/after values, destination, risk, affected records, approver identity, valid-until time, and post-action verification. Approval must be bound to immutable proposed action payload.

**Agent Studio:** Guided builder first; advanced workflow graph second. Simulated tool use and previewed authorization before publishing. Show capabilities in user language ("Can prepare drafts" not `email.draft.write`).

## Design system

All milestones implement the same [interface system](07-interface-system.md), including shared element states and the workspace/Studio/administration hierarchy. Feature-local visual systems are not permitted.

Cohesive typography, neutral base, intentional accent colors, comfortable spacing, light/dark modes, soft but legible corners, meaningful animations with reduced-motion support. Accessible contrast and focus states. Real icon library, no decorative fake buttons, no gradients used as a substitute for hierarchy. Reusable table, entity reference, activity log, trace viewer, and permission disclosure components.

## Accessibility and performance

WCAG 2.2 AA target (require independent accessibility validation); keyboard access to major flows, screen reader support, descriptive status messages, high contrast, visible loading/error states, reduced motion, and responsive/mobile-safe layouts. Virtualize lengthy timelines and large tables. Optimistic UI must reconcile with authoritative server state and explain conflicts.

## Terminology

Employee-facing: "assistant", "work", "approval", "knowledge", "connection", "access", "activity". Builder-facing advanced: "agent run", "capability", "model route", "policy", "trace", "idempotency". Product copy should not require understanding software architecture.

## Distinctive interaction goals

- No prompt is required to see useful contextual suggestions.
- Suggested actions are never represented as completed actions.
- Conflicts, errors, pending approvals, and stale information are visually distinct.
- A user can always answer: who is responsible, what will happen, which data are used, and how to stop it.
- Empty states teach one valuable next action rather than listing dozens of possibilities.
