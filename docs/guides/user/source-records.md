---
title: Source records and reviewed changes
audience: user
area: connections
tickets: [EXP-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/records/page.tsx, apps/web/src/app/o/[organizationId]/records/[recordId]/page.tsx, packages/application/src/business-records.ts, packages/database/migrations/0739_business_record_read_authority.sql, packages/database/migrations/0740_business_record_revocation.sql, packages/database/migrations/0747_business_change_authority.sql, packages/database/migrations/0748_business_lock_source_facts.sql, packages/database/migrations/0749_business_team_grant_lock.sql, apps/web/src/server/business-record-actions.ts]
tests: [tests/integration/business-actions.test.ts, tests/stack/business-actions-api.test.ts]
---

# Source records and reviewed changes

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Generated local API and browser checks are recorded in the release candidate report. This guide still awaits the required CI-backed checks and independent user walkthrough. Full customer connector setup and provider acceptance remain unfinished.

Open **Source records** in your workspace. Choose a **Record kind** and press **Apply filter**, or use **Clear filters** to return to all kinds. **Next records** opens another page when more are available. Filtering and navigation work without JavaScript.

Only selected fields last read from a connected CRM, ticketing or accounting source appear. The source must grant you access directly or through your team. Being a company administrator adds no access. An empty list can mean no selected records have synced, no source grant maps to you, or the connection is unavailable. It does not show how many hidden records exist.

Open a record to see its source name, reference, version, classification and last-read time. These are stored values, so check the connected system for its latest state. A changed snapshot stays hidden until its corresponding source permissions commit. Removing a grant or revoking the connection removes access on the next request.

## Propose a change

If connected actions are enabled, **Propose a field change** lists the fields this source allows you to change. Choose a field, enter its new value, or select **Clear this field**. Dates use YYYY-MM-DD. The source must provide a record version; a missing or changed version prevents an update.

Enter a **Work title**, choose an **Independent reviewer** who already has source access, and press **Request review**. The request creates Work, shares that Work with the reviewer, and asks them to review the exact proposed values. It grants no source access. Invalid input leaves no new Work or approval; your form values remain so you can correct them. The forms also work without JavaScript.

The review page shows exactly which source record, version and fields the proposal covers. The requester cannot approve it. After approval, the receipt on the Work page says whether Ensemus has tried, whether the connected system accepted it, or whether the outcome is unknown. Approval alone does not mean the source changed. Current connection scopes, source grants and the source version are checked again before an attempt.

## Ticket notes and invoice drafts

On a ticket, **Propose an internal ticket note** offers an internal note only. It cannot send a customer-facing reply.

On an accounting record, **Propose an invoice draft** accepts a customer reference, currency, line description, quantity and unit price. Enter amounts as decimal text. A draft posts and pays nothing; someone reviews it in the accounting system. Payment record fields remain read only. Restricted records cannot be proposed as external changes.

## Check the outcome

An uncertain result stays **unknown**. Ensemus does not silently retry an action that may already have happened. Check the connected system using the Ensemus request key on the receipt, then record what you found. A person's finding is shown as that person's finding, separately from confirmation by the connected system.

Changing a pending proposal needs a new approval; the old one cannot be spent. A proven failed action can be asked for again with its own new approval. The business APIs support revisions and retries. The record forms create proposals; the receipt view offers retries, while editing a business proposal in the browser is still unfinished.

Removing a source grant hides record-backed proposals and their reviews on the next request. Invoice drafts name no existing target record: their manually entered content remains protected by their Work and connection access. Installing a department pack grants no source access or connector. Customer connection setup, built-worker execution and real provider acceptance remain separate release gates.
