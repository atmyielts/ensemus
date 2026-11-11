# Knowledge production readiness (rc-know)

**2026-11-12. Source and unit evidence only.** Built on `codex/rc-know` without Docker or a database. Design
and decisions are in ADR-029's D2, D4 and D6 addenda.

## What changed

| Area | Change |
|---|---|
| Formats | PDF (`pdfjs-dist` 6.4.299, Apache-2.0), Word, PowerPoint and Excel (built-in ZIP and XML readers over Node's `zlib`). New codes `ENCRYPTED_DOCUMENT`, `NEEDS_OCR`, `MALFORMED_DOCUMENT`, `SCAN_FAILED` |
| Parse thread | `fetch`, sockets and console closed before any parser loads; 320 MiB heap; 15 s or 60 s deadline |
| Malware | Scan before parse through clamd; `not_scanned`, `clean`, `infected`, `scan_failed`; policy setting; Compose overlay under the `malware-scan` profile; runbook `docs/05-operations/malware-scanning.md` |
| Vector search | Partial HNSW indexes for five widths (0711); iterative scan with the ACL in the statement; exact at or below 20,000 authorized vectors; recall script mirrors production |
| Domain shares | `org.security_policies.knowledge_domain_grants`, off by default, in `readable_source_ids` (0712) |
| Backlog | `KNOW-01` to `KNOW-06`, `MODEL-05`, `SEC-03`, `UX-18`, `UX-22` moved from `not_started` to `partial`: code and real-role tests exist from M5, and measured recall, provider ports, built journeys and outside review remain open |

Migrations 0710 and 0712 begin `-- FLAGGED FOR HUMAN SECURITY REVIEW`.

## What ran

Typecheck, lint, Prettier, backlog, license and unit checks ran locally; their results are in the commit
that adds this file and the builder's report. The emitted worker bundle parsed a generated PDF and Word
file through its own parse thread, with `pdfjs-dist` external, and reported `NEEDS_OCR` for a scan.

## What did not run

- The integration tests for scanning (`knowledge-ingest`), approximate search (`knowledge-retrieval`) and
  domain grants (`knowledge-domain-grants`), and migrations 0710 to 0712 on a real PostgreSQL. They need
  the Compose database.
- `tests/measure/knowledge-recall.measure.ts`. No recall figure is claimed.
- clamd itself. The client was tested against a local protocol stand-in only.
- No real document, malware sample or credential was used. Every fixture is generated in its test.
