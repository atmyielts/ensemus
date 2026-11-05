# Personas, permission assumptions, and critical user journeys

## Personas

**Owner / executive:** Wants a trustworthy concise account of the company, not endless dashboards. Can ask for explanations of blockers and approve strategic actions. Executive role does not automatically bypass legal or personal-data boundaries.

**Manager / team lead:** Coordinates staff, projects, and agent capacity; reviews deliverables; configures team workflows within delegated authority. Sees only permitted business data.

**Contributor:** Owns assignments, drafts outputs, collaborates, finds accurate information, invokes approved assistants, and can challenge incorrect memory facts.

**Workspace admin:** Manages membership, roles, integrations, model/provider profiles, retention, entitlements, and billing. Admin powers must be segmented from confidential human resources and legal data where policy requires it.

**Security steward:** Owns classification, risk policies, egress reviews, incident investigation, audit export, access review, and sensitive connector approvals. Ideally separate from billing/operator roles.

**AI engineer / agent builder:** Creates versioned, tested skills and agents; cannot publish privileged capabilities without review; sees masked traces unless explicitly authorized.

**Sovereign operator:** Owns host infrastructure and backups, replaces secrets, provisions inference endpoints, validates offline mode and upgrades. Cannot assume platform administrative role solely by possessing infrastructure access; separation is limited by host control and must be documented.

## Journey A — onboarding a new company

1. Organization owner selects Cloud, BYOM, or a licensed Sovereign deployment and sees the data/model responsibility statement.
2. Sets region and retention defaults; invites first team; defines company structure and projects.
3. Connects or creates first trusted knowledge source; connector shows exact scopes and destination of data.
4. Assigns provider profiles: Ensemus-managed, customer API key, or private inference. Restricted-data egress remains disabled by default.
5. Runs a zero-side-effect guided simulation of the first workflow.
6. Activates with a small Work Unit; outcome and security posture are visible.

**Failure handling:** incomplete provider setup leaves AI optional; non-AI core should remain usable. Connection failures never silently fall back to unrelated providers.

## Journey B — manager delegates a research task

1. Manager creates outcome: `Prepare source-backed competitor overview by Friday`.
2. User selects approved Research Agent; platform previews accessible sources, output format, allowed tools, cost estimate range, and approval mode.
3. Runtime compiles context, runs bounded research, produces structured report with citations and limitations.
4. Reviewer accepts, requests change, or cancels; feedback is retained as run evaluation, not silently applied as authoritative company memory.
5. Completed report becomes a governed artifact linked to the Work Unit.

## Journey C — sensitive email approval

1. Agent drafts an external email under an approved business workflow.
2. Policy classifies `email.send` as consequential; creates an approval bound to recipients, subject/hash of final body, destination account, and expiry.
3. Named authorized approver reviews exact content; approval resumes durable workflow.
4. Action gateway sends with idempotency/reconciliation; external message ID and success/failure are recorded.
5. Edited content after approval invalidates the approval and requires re-authorization.

## Journey D — BYOM security administrator

Admin registers approved provider endpoint, data region, model capabilities, retention claims backed by a contract, and authorized data classifications. API secret goes directly to vault, never to agent prompts, UI logs, or worker environment dumps. Egress simulator identifies which workflows would transmit data. If the provider fails, the platform pauses or uses a separately approved fallback.

## Journey E — Sovereign offline operator

Operator receives signed release artifacts, checksum manifest, dependency SBOM, deployment instructions, upgrade plan, and offline licensing material. Ensemus runs within their network using a private inference endpoint. Internet disconnection, licensing server unavailability, and maintenance cancellation do not disable licensed functionality. Automatic updates and telemetry are off unless explicitly enabled and compatible with contract.

## Journey F — customer leaves platform

Authorized admin requests export of structured records, history, files, policy/configuration, agent/skill definitions, relationship edges, and usable provenance metadata. Platform generates encrypted export with manifest and checksums; verifies restore/import in staging; revokes provider credentials; deletes within contractual/legal timeframes; records certificates/audit evidence where appropriate.
