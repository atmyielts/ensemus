---
title: Agents and runs
audience: user
area: agents
tickets: [AGENT-01, AGENT-02, AGENT-06, AI-13]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [m4-agents:apps/web/src/app/o/[organizationId]/settings/agents/page.tsx, m4-agents:apps/web/src/app/o/[organizationId]/settings/agents/publish-form.tsx, m4-agents:apps/web/src/app/o/[organizationId]/settings/agents/actions.ts, m4-agents:apps/web/src/app/api/v1/organizations/[organizationId]/agent-versions/route.ts, m4-agents:apps/web/src/app/api/v1/organizations/[organizationId]/agent-versions/[agentVersionId]/route.ts, m4-agents:packages/application/src/ai/agents.ts, m4-agents:packages/policy/src/agent-spec-lint.ts, m4-agents:packages/contracts/src/ai.ts]
tests: []
---

# Agents and runs

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

You can publish a version of an agent. **You cannot run one yet:** nothing starts a run, and no page shows one. This page covers publishing.

## What a published version is

A version is one agent definition, fixed for good. It cannot be edited or deleted. To change an agent, you publish a new version, and new runs will use that one. **Agents** marks it **Used for new runs**. Each version shows when it was published, under which policy version, and its SHA-256, which identifies its exact content.

The page is at `/settings/agents` under your organization's address. The main navigation has no link to it yet.

## Who can use it

Owners and admins can see the list and publish. Anyone else sees **Owners and admins manage agents here. Ask one of them if you need a change.**

## Publish a version

Publishing takes two things, each pasted as JSON into **Publish a version**:

- **Agent manifest:** the agent's definition.
- **Evaluation report:** the passing report for exactly that manifest. It has to name the manifest's SHA-256 and the policy version the page shows you. Changing the manifest needs a new report.

The product does not make this report for you yet. Choose **Publish this version**. When it works, you see **Version 1 is published, and new runs will use it. Runs already going keep the version they started on.**, with your version's number.

### What the manifest holds

| Part | What it says |
|---|---|
| `api_version` | Always `ensemus.ai/v1` |
| `id` | A short name in lowercase letters, digits and dashes. The same `id` means a new version of the same agent |
| `version` | A whole number, higher than this agent's newest version |
| `objective`, `instructions` | What the agent is for, and what it is told. Put no secret here |
| `model` | The capabilities it needs, a quality tier, and whether it may use a fallback model |
| `context` | What it may read. `memory_write_policy` is `none` or `propose_only` |
| `tools` | The tools it may use (`allow`), and may not (`deny`). See [What agents may do, and approvals](agent-tools-and-approvals.md) |
| `execution` | Its limits: model turns, tool calls, tokens, cost in US dollars, active seconds, and how deep it may delegate |
| `output` | The shape its output has to take, and which checks it must pass |
| `evaluation` | The evaluation suite, and the pass rate it needs |

## When it refuses

A refused publish creates nothing, and the form keeps what you typed so you can fix it. A refused manifest or report is recorded, with its code and none of its content.

**"This agent definition is not valid."** comes with the reason:

| What you see | What to do |
|---|---|
| **It allows a tool that does not exist.** | Remove it from `allow` |
| **It allows a tool no agent may have, such as one that reads secrets or changes a model, budget, policy or grant.** | Remove it. No setting allows these |
| **It both allows and denies the same tool.** | Keep it in one list |
| **A limit is higher than this organization allows. Without a policy that says otherwise, an agent cannot delegate.** | Lower the limit. With no policy, `max_delegation_depth` has to be 0 |
| **It lists skills, and agents cannot use skills yet.** | Remove `skills` |
| **Check these fields:** and a list | Those fields are missing or the wrong kind. Extra fields are refused too |
| **Part of it could not be read.** | Check the JSON |

The other answers:

- **"This agent version needs a passing evaluation before it can be published."** The report is missing, did not pass, is below the manifest's pass rate, or names another manifest, suite or policy version. A report does not carry over, so if the policy changed, you need a new one.
- **"Someone else changed this first. Check the latest version and try again."** Your `version` is not higher than the newest, or someone published at the same moment. Use a higher number.
- **"Your organization’s policy does not allow this."** Your organization's agent policy could not be read, so nothing can be published against it. Ask whoever manages that policy.
- **"You do not have permission to do that."** You are not an owner or admin. An agent cannot publish, whoever started it.

Another organization's agents never appear here, and asking for one by ID answers **Not found**, the same as an ID that does not exist.

## From the public API

`GET` and `POST /api/v1/organizations/<id>/agent-versions` list and publish, and `GET` on `/agent-versions/<version id>` reads one. A refused manifest answers with the rule codes and field names, and repeats nothing you sent.
