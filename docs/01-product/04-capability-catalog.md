# Capability catalog and extensibility roadmap

**Legend:** Core = shared domain primitive; Pack = installable industry/team configuration; Integration = external system is authoritative; Advanced = later opt-in capability. This is a **target catalog**, not an assertion that every feature already exists.

| Capability | Type | Core behavior | Guardrail |
|---|---|---|---|
| Organization & departments | Core | Teams, roles, hierarchy, directory | Segregated access |
| Company Pulse | Core | Evidence-backed operating picture | No fabricated employee scoring |
| Project and Work Units | Core | Outcomes, work DAG, assignments, artifact closure | Cycles rejected; owner required |
| Client relationships | Core | Entities linked to work, contracts, people | Customer-specific ACL |
| Search and knowledge | Core | Hybrid retrieval, citations, source freshness | Retrieval permission trimming |
| Document collections | Core | Files, lists, labels, comments | Version and retention awareness |
| Meetings and summaries | Integration + core artifacts | Import notes, derive proposed decisions/work | Consent and provider approval |
| Personal assistant | Core | Scoped suggestions and delegated bounded work | Same permissions as principal |
| Team agents | Core | Shared approved skills and memory | Service identity and policy |
| Workflow automation | Core | Triggers, approvals, durable execution | No unbounded loops |
| Agent Studio | Core builder | Version, simulate, evaluate, publish | Review privileged capabilities |
| Skills catalog | Core | Portable, tested procedural packages | Signed packages; sandbox |
| Email and calendar | Integration | Sync authorized events; draft or schedule | Approval for external sends |
| CRM / ticketing / accounting | Integration | Read/update selected records | Reconciliation + provider scopes |
| Sales operations | Pack | Pipeline follow-ups, research, client onboarding | No unsanctioned bulk outreach |
| Marketing operations | Pack | Campaign planning and artifact review | Claims/source review |
| HR operations | Pack | Onboarding and internal workflows | Strict employment data isolation |
| Finance operations | Pack | Reporting and approval preparation | Never autonomous transfers by default |
| Learning/knowledge programs | Pack | Internal skill and policy enablement | Consent and privacy |
| Custom objects | Advanced core | Typed schema extensions and relationships | Authorization and schema limits |
| Marketplace | Advanced | Approved skills, connectors, packs | Signature/security review |
| Cross-org agent collaboration | Advanced | Explicit intercompany delegated work | No implicit federation |
| Sovereign air-gap | Deployment capability | No mandatory external dependencies | Offline provider and telemetry tests |

## Bundled workflows for initial vertical

1. Opportunity won → onboarding plan → approval → project setup → kickoff artifact.
2. Meeting summary → action extraction → owner assignment → due-date tracking → verified completion.
3. Project completion → deliverable review → finance handoff → invoice draft in accounting system.
4. New employee → policy pack → tasks → access request/approval → onboarding checklist.
5. Client status inquiry → evidence gathering → draft update → review/send.

## Pack format

A pack includes object/view schemas, agent definitions, skills, workflow blueprints, policy requirements, localization strings, and evaluation scenarios. Installing a pack cannot grant permissions automatically: administrators must review each requested capability and classified data access. Pack upgrades require migration and rollback paths.

## Universality constraints

Custom-object fields and relationships must be schema-validated, versioned, and indexed intentionally. Use configurable views and packs for variation, but keep platform-level event, identity, billing, security, and work semantics stable. Integration packs cannot claim to provide full compliance with industry legislation.
