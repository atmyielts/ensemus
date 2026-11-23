---
title: Usage and budgets
audience: user
area: agents
tickets: [MODEL-04]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/settings/budgets/page.tsx, apps/web/src/app/o/[organizationId]/settings/budgets/actions.ts, apps/web/src/app/api/v1/organizations/[organizationId]/budgets/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/usage/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/entitlements/route.ts, packages/application/src/ai/budget.ts, packages/application/src/ai/usage.ts, packages/commercial/src/index.ts, apps/web/src/lib/messages.ts]
tests: []
---

# Usage and budgets

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

**Budgets and usage** shows what agents may spend, what they have spent, and why any were stopped. With no budget set, no agent can run. Nothing sets a budget for you.

The page is at `/settings/budgets` under your organization's address. The main navigation has no link to it yet.

## Who can use it

Owners and admins can see the page and set budgets. Anyone else gets the same **Not found** answer as for a page that does not exist.

## Set a budget

1. Under **Month**, pick the month and choose **Show**. Months are in UTC, and it opens on the current month.
2. Under **Budgets for** that month, choose what it **Applies to**: **This organization**, or one published version of an agent.
3. Type the **Limit in US dollars** and choose **Set budget**.

A budget covers one month, so a new month needs a new one. Setting it again replaces the limit, and what was already spent and held stays as it is. You can set a limit below what was spent: that stops new calls, and takes nothing back.

An agent version's budget sits inside the organization's. A call has to fit both.

## Read the usage

| What you see | What it means |
|---|---|
| **Spend** or **Estimated spend** | What the month's calls cost. It says **Estimated spend** when any of it is an estimate |
| **Held for calls in progress** | Set aside for calls that have not finished, so two calls cannot both take the last of a budget |
| **Organization limit** | The organization's budget for the month, or **Not set** |
| **Tokens sent and received** | Measured tokens in each direction |

**Estimates can run higher than the real bill.** They come from your rate cards, and a call whose answer was lost counts at the most it could have cost. So the figure may be higher than your provider's invoice. It leans that way on purpose: a budget may over-count a call, and must not forget one.

No agent can run yet, so these figures stay at nothing until runs arrive. See [Agents and runs](agents-and-runs.md).

## Where the modes differ

| | Ensemus Cloud | Your own model provider, or your own deployment |
|---|---|---|
| **What this organization has** | Nothing until your account includes it. You will see **Nothing is included yet, so agents cannot run.** | **Running agents** and **Calling a model**, because you pay for your own models |
| **The figures** | **Spend**, unless part of it is an estimate | Always estimates, with the line **Ensemus does not bill for this usage: your model provider does.** |

This page shows no prices or allowances.

## When it refuses

- **"No budget is set for this month, so agents cannot run in it."** This is the budget list being empty. Set one for the month.
- **"Please check the details and try again."** The limit has to be a plain number, with at most six decimal places and no currency sign. You also see this if the agent version belongs to another organization: you can only set a budget on your own.
- **"You do not have permission to do that."** You are not an owner or admin, or your role changed. Ask one of them.

An agent can never set or raise a budget. Only a person can.

## Why agents were stopped

This section lists the month's stops with their code and a count of runs, and no content from the work. It separates three different answers, because each sends you somewhere else:

| What you see | Code | What to do |
|---|---|---|
| **Not included for this organization. This is about the account, not your rules.** | `ENTITLEMENT_DENIED` | Look at your account. Your policy did not cause this |
| **Stopped by a spending limit, or by a model with no rate card.** | `BUDGET_EXHAUSTED`, `BUDGET_NOT_CONFIGURED`, `RATE_CARD_MISSING`, `COST_LIMIT` | Raise or set the budget, or give the model a rate card |
| **Stopped by your organization’s own policy. The account would have allowed it.** | `POLICY_DENIED`, `PROFILE_CHANGED` | Look at your own policy and model profile |

An entitlement can only stop a call. It can never allow something your policy denied.

## From the public API

The same answers come from `GET /api/v1/organizations/<id>/usage?period=2026-01`, `GET /api/v1/organizations/<id>/entitlements` and `POST /api/v1/organizations/<id>/budgets`, with the same permission checks. A request for another organization's data shows nothing from it.
