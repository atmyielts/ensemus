# Agent Studio, skills, tool contracts and publishing

## User model

Employees should configure an agent by defining a role, intended outcome, boundaries, approved knowledge, tools, triggers, spending cap, autonomy mode, output format, and owner. The UI is approachable; the generated implementation artifact is a versioned typed manifest, not a naked prompt.

## Core entities

`agent_definitions` (ownership/name) → immutable `agent_versions` (model capability, skill versions, tool grants, memory scopes, policies, timeout and budget) → `agent_publications` (environment, activation window) → `agent_runs` (immutable version used) → `execution_steps` and `artifacts`.

**Skills** are reusable versioned procedures with inputs/outputs, documented instructions, validator and tests; **Tools** are executable connectors/functions with independent authorization; **Triggers** select when a published agent runs; **Workflows** own durable orchestration, not the skill manifest.

## Declarative format

See `specifications/schemas/agent-definition.schema.json` and `specifications/examples/sales-researcher.agent.yaml`. TypeScript implementations should validate with Zod/JSON Schema at publish time and again in workers. Prompt text is one component of the manifest; permission changes require explicit administrator approval and audit. Agent identity never imports arbitrary package code from uploaded Markdown instructions.

## Publishing pipeline

Draft → validate schema → lint tool grants → risk assessment → conformance tests on synthetic/redacted fixtures → agent evaluation set → policy/security simulation → publish immutable version → canary activation → monitor → rollback/pin old version. An existing Work Unit should not silently swap agent versions while running.

## Skill supply-chain security

Approved owner, package digest/signature, version, license, allowed dependencies, tool boundaries and execution environment. Optional user-authored code executes in sandbox with no ambient tenant DB credentials, constrained network/filesystem, time/memory limits and ephemeral credentials issued per action. Prefer typed workflow and external API tools over arbitrary shell execution.

## Models and run optimization

Agent selects capability tier, not raw commercial model. Support tenant-approved override, adaptive model selection and policy-secure fallback. Dynamic list of tools is filtered by actor + agent grants to minimize prompt size and reduce attack surface. Avoid redundant multi-agent handoffs; a deterministic helper is not an agent.

## Agent Studio requirements

Friendly setup wizard, scoped knowledge picker, human-approval chooser, dry-run with visible estimates, source/permission preview, version history, change diff, usage/budget dashboard, run history and replay/recovery inspector. Sensitive tools display explicit risk and approval requirements. Users cannot disable organization-wide policies by selecting an 'autonomous' mode.
