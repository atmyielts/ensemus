# Release readiness checklists and failure scenarios

## Pre-release checklist

- [ ] Product scope and acceptance cases approved.
- [ ] Data model and contract changes have ADR and migration plan.
- [ ] Tenant/ACL tests and RLS tests pass using non-owner roles.
- [ ] Skills/agents have immutable versions, signed provenance, passing evaluation.
- [ ] Provider egress classifications tested for Cloud, BYOM and Sovereign.
- [ ] Full secrets scan, SBOM/license scan and dependency vulnerability scan complete.
- [ ] External side effects have idempotency/reconciliation tests.
- [ ] Trace/log samples have no raw prompts, credentials, restricted content.
- [ ] Backups restored successfully in isolated environment.
- [ ] Latency, cost and success criteria measured on named workload profile.
- [ ] Accessibility/keyboard/contrast tested.
- [ ] Pricing/entitlements and maintenance contract have sign-off.
- [ ] Release artifacts signed and documentation current.

## Mode-specific checklist

**Cloud:** vendor provider accounts/terms, credit allowance, billing reconciliation, approved regions, failover policy, customer usage display.

**BYOM:** secure credential capture, private endpoint allowlist, explicit fallback set, no Ensemus inference charge, per-provider capability test, egress transparency.

**Sovereign:** no mandatory external DNS, local licensing, third-party telemetry disabled/audited, offline images/SBOM, customer model compatibility, installation/upgrade/recovery runbooks, license remains usable after maintenance expires.

## Required fault scenarios

1. User revokes file access while agent is compiling context.
2. Model fails halfway through report generation.
3. Operator rolls a worker during approval wait.
4. External send succeeds but network times out before receipt.
5. Database transaction commits but outbox publisher crashes.
6. Tool gateway receives an authorization decision for a now-changed proposal.
7. User belongs to two organizations, switches rapidly during request/stream.
8. An imported document contains instructions to ignore tool policy.
9. Agent delegates recursively and tries to exceed spending ceiling.
10. BYOM endpoint redirects to unapproved provider or fails.
11. Sovereign instance boots with zero internet connectivity.
12. Model embedding version changes while old search index is still present.

Each scenario should have automated tests where feasible and manually verified evidence for infrastructure-specific behaviors. `specifications/qa-scenarios.csv` supplies a tracking sheet.
