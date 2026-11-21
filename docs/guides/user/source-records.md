---
title: Reading source records
audience: user
area: connections
tickets: [EXP-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/o/[organizationId]/records/page.tsx, apps/web/src/app/o/[organizationId]/records/[recordId]/page.tsx, packages/application/src/business-records.ts, packages/database/migrations/0739_business_record_read_authority.sql, packages/database/migrations/0740_business_record_revocation.sql]
tests: []
---

# Reading source records

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This guide covers the read pages. Full connector setup and provider acceptance remain unfinished.

Open **Source records** in your workspace. Choose a **Record kind** and press **Apply filter**, or use **Clear filters** to return to all kinds. **Next records** opens another page when more are available. Filtering and navigation work without JavaScript.

Only selected fields last read from a connected CRM, ticketing or accounting source appear. The source must grant you access directly or through your team. Being a company administrator adds no access. An empty list can mean no selected records have synced, no source grant maps to you, or the connection is unavailable. It does not show how many hidden records exist.

Open a record to see its source name, reference, version, classification and last-read time. These are stored values, so check the connected system for its latest state. A changed snapshot stays hidden until its corresponding source permissions commit. Removing a grant or revoking the connection removes access on the next request.

Changes cannot be proposed from this view yet. Accounting values are read only; nothing on these pages posts an invoice or moves money. Installing a department pack does not grant source access or make a connector available. Full connector setup, live synchronization and reviewed external changes have separate release gates.
