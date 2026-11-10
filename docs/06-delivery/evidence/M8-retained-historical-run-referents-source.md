# Retained usage evidence and historical run referents (0552) — source only

FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet reviewed by a person. Written by an agent in CI
repair round 11 (erasure-retained-fks-0552 group, findings 1 and 10). The additive migration is
`packages/database/migrations/0552_retained_historical_run_referents_r11erasure.sql`, journal idx 112,
kept as 0552 at the round 11 merge (no other round 11 branch added a migration). No pushed migration (0100, 0101, 0216, 0501, 0508,
0511, 0516, 0518, 0548-0551) is edited. Docker was not available to the author: the SQL has not been
applied locally, and the evidence below is from the CI log and the source.

## The defect (finding 1)

CI run 42706818569, integration shard 5/6,
`tests/integration/agent-delegated-offboarding.test.ts` > `[ADR028-Q12-L6] [ADR028-Q12-L8b]`: the
resumed erase finished with `leftOver` holding `ROWS_REMAIN` for `ai.agent_definitions`,
`ai.agent_runs`, `ai.agent_versions`, `ai.execution_steps`, `ai.model_profiles`, `ai.rate_cards`,
`knowledge.structured_record_catalog`, `org.memberships`, `org.service_identities` and
`work.work_units`.

`lifecycle.retained_table` (0501, wrapped by 0516) keeps every `platform` table except
`notifications` and `idempotency_keys`, and all of `governance`, through erasure: billing, usage and
audit evidence outlive the tenant (LIFE-04). Several of those retained tables held `NO ACTION` FKs
into tables the eraser must empty. `eraseTenantRows` treats `23503` as "try again next pass", so the
referenced rows could never be deleted, and every row they in turn reference stayed with them:

| Pinned directly | By |
| --- | --- |
| `ai.agent_runs` | `platform.budget_reservations`, `platform.usage_ledger`, `governance.egress_decisions` (`run_id`) |
| `ai.execution_steps` | the same three (`step_id`) |
| `ai.model_profiles` | `platform.usage_ledger`, `governance.egress_decisions` (`profile_id`) |
| `ai.rate_cards` | `platform.usage_ledger` (`rate_card_id`) |
| `work.work_units` | `platform.usage_ledger` (`work_unit_id`) |
| `ai.model_jobs`, `ai.model_call_attempts` | `platform.budget_reservations`, `platform.usage_ledger` (0216) |
| `ai.agent_versions` | `platform.budgets` (`agent_version_id`) |
| `org.memberships` | `platform.budgets`, `governance.policy_bundles` (`created_by_membership_id`), `governance.kill_switches` (`engaged_by_membership_id`, `released_by_membership_id`) |

Transitively: `ai.agent_definitions` (by the pinned versions), `org.service_identities` (by the pinned
runs) and `knowledge.structured_record_catalog` (0211's `structured_catalog_keep` refuses to delete a
catalogue row whose Work is still alive).

## Enumeration

Every FK whose table is `lifecycle.retained_table(...) = true` and whose referenced table is a tenant
table the eraser empties (relkind `r`/`p`, not a partition, an `organization_id` column, not retained:
the rule of `listErasableTables` in `packages/database/src/eraser.ts`). Enumerated statically from every
journaled migration (inline `REFERENCES`, `FOREIGN KEY` clauses and `ALTER TABLE ... ADD CONSTRAINT`,
less every `DROP CONSTRAINT`), and cross-checked by a raw scan of every `REFERENCES` under a retained
`CREATE`/`ALTER TABLE`. The only other retained->erasable FKs ever written were 0512's sixteen
historical payment referents, which 0518 already dropped. Names over 63 bytes are PostgreSQL's
truncated names, which is what `pg_constraint` holds.

| Table | Dropped FK (columns -> target) |
| --- | --- |
| `platform.budget_reservations` | `budget_reservations_organization_id_run_id_agent_runs_organizat` (run_id -> ai.agent_runs) |
| | `budget_reservations_organization_id_step_id_execution_steps_org` (step_id -> ai.execution_steps) |
| | `budget_reservations_model_job_fk` (model_job_id -> ai.model_jobs) |
| | `budget_reservations_model_call_fk` (model_call_id -> ai.model_call_attempts) |
| `platform.budgets` | `budgets_organization_id_agent_version_id_agent_versions_organiz` (agent_version_id -> ai.agent_versions) |
| | `budgets_organization_id_created_by_membership_id_memberships_or` (created_by_membership_id -> org.memberships) |
| `platform.usage_ledger` | `usage_ledger_organization_id_rate_card_id_rate_cards_organizati` (rate_card_id -> ai.rate_cards) |
| | `usage_ledger_organization_id_work_unit_id_work_units_organizati` (work_unit_id -> work.work_units) |
| | `usage_ledger_organization_id_run_id_agent_runs_organization_id_` (run_id -> ai.agent_runs) |
| | `usage_ledger_organization_id_step_id_execution_steps_organizati` (step_id -> ai.execution_steps) |
| | `usage_ledger_organization_id_profile_id_model_profiles_organiza` (profile_id -> ai.model_profiles) |
| | `usage_ledger_model_job_fk` (model_job_id -> ai.model_jobs) |
| | `usage_ledger_model_call_fk` (model_call_id -> ai.model_call_attempts) |
| `governance.egress_decisions` | `egress_decisions_organization_id_run_id_agent_runs_organization` (run_id -> ai.agent_runs) |
| | `egress_decisions_organization_id_step_id_execution_steps_organi` (step_id -> ai.execution_steps) |
| | `egress_decisions_organization_id_profile_id_model_profiles_orga` (profile_id -> ai.model_profiles) |
| `governance.kill_switches` | `kill_switches_organization_id_engaged_by_membership_id_membersh` (engaged_by_membership_id -> org.memberships) |
| | `kill_switches_organization_id_released_by_membership_id_members` (released_by_membership_id -> org.memberships) |
| `governance.policy_bundles` | `policy_bundles_organization_id_created_by_membership_id_members` (created_by_membership_id -> org.memberships) |

0552's first statement refuses (`RETAINED_REFERENT_SCHEMA_UNREVIEWED`, EN850, DETAIL naming it) when
any of the nineteen is missing or differs in table, target or columns, or when the catalogue holds a
retained->erasable FK outside this list. It never drops an unreviewed FK.

## What stays

- Every historical UUID column and value. Nothing is rewritten, nulled or deleted; no index changes.
- Every FK between retained rows: `budget_reservations -> budgets`, `usage_ledger -> budget_reservations`,
  `usage_ledger.corrects_id -> usage_ledger`, `outbox_events -> domain_events`,
  `lifecycle.offboarding_agent_stops` and `lifecycle.standing_stop_receipts -> kill_switches`, and the
  billing and lifecycle FKs among themselves.
- Every FK to `org.organizations`.
- Every native and append-only guard on the six tables, re-checked by name, function and enabled state
  in the postcondition: `usage_ledger_append_only`, `egress_decisions_append_only`, `kill_switches_keep`
  (`app.reject_change`), `model_usage_principal`, `model_reservation_principal`
  (`ai.guard_model_money_principal`), `scoped_model_reservation`, `authority_reservation_write`,
  `authority_egress_write`, `egress_run_input_protocol`, `kill_switches_check_change`,
  `kill_switch_offboarding_release`, `kill_switch_standing_release`. The six tables remain retained, and
  `ensemus_eraser` has no DELETE or TRUNCATE on them.
- Every grant and RLS policy. No role gains anything.

No retained->erasable FK is needed. No guard reads one as proof of anything after birth: the money
guards (0216), scope and authority guards (0414, 0417) and the run-content fence (0214) read the run,
model call, budget and rate card themselves at INSERT.

## Birth without the FK

A retained row names its run, step, profile, rate card, Work, agent version and people as they were
when it was written. The writers already hold those referents: the agent's own run and step under the
0214/0414/0417/0216 admission guards, the egress log only for `context.agentRunId`, and a person's own
`membershipId` for kill switches. One product path relied on the FK as its check:

- **Product fix:** `setBudget` (`packages/application/src/ai/budget.ts`) relied on
  `budgets -> agent_versions` to refuse an agent version of another tenant (`FOREIGN_REFERENCE`). It now
  reads the version under RLS before the birth, as `engageKillSwitch` already did for its target, and
  refuses the same way. Covered by `tests/integration/ai-usage.test.ts` (another tenant's version) and
  `tests/integration/retained-erasable-foreign-keys.test.ts` (own version accepted; another tenant's and
  a never-existing one refused, no row written).

**For the reviewer:** a role that holds INSERT on these tables (`ensemus_agent` on usage, reservations
and egress; `ensemus_app` on budgets, policy bundles and kill switches) can now write a UUID that names
no live row of its own tenant. RLS still confines the row to its own tenant, the guards above still
apply, and no authority is derived from such a UUID. A database-level birth check was not added
because the referenced tables' RLS policies are `TO ensemus_app`, so neither a SECURITY DEFINER check
owned by the migrator nor a row lock taken by the inserting role could be verified without a database.

## Finding 10

0551's postcondition no longer re-checked 0550's `lifecycle.raw_active_source_requalifications`. 0552's
last statement re-checks it: forced RLS, owned by `ensemus_migrator`, exactly the one permissive ALL
policy `raw_active_source_requalification_owner` for `ensemus_migrator`, no ACL entry for anyone but the
owner (PUBLIC included), no column ACL, no table or column privilege of any kind for `ensemus_app`,
`ensemus_agent`, `ensemus_auth`, `ensemus_secrets`, `ensemus_dispatcher`, `ensemus_eraser`,
`ensemus_operator` or `ensemus_support`, still retained, and its `raw_active_source_requalification_keep`
trigger enabled, `app.reject_change()`, BEFORE UPDATE, DELETE and TRUNCATE, once per statement.

## Tests

- `tests/integration/agent-delegated-offboarding.test.ts` L6/L8b: the tenant's agent reserved and
  spent budget (genuine model turn) and logged an egress decision naming the run and its profile; the
  erase now reports `leftOver: []`, the run, profile, rate card and Work are gone, and every retained
  reservation, usage and egress row survives with the historical UUIDs it was written with.
- `tests/integration/retained-erasable-foreign-keys.test.ts`: zero retained->erasable FKs in
  `pg_constraint`; the nineteen are gone and their uuid columns stay; the retained->retained and
  organization FKs exist; the catalogue check finds a re-added FK (negative); 0552's postcondition holds
  on the migrated database and refuses, as the migrator in a rolled-back transaction, a re-added FK, a
  dropped retained FK, a renamed historical column, a disabled append-only trigger, and each finding-10
  regression (runtime table, column and PUBLIC grants, RLS not forced, a second policy, the keep trigger
  disabled); the requalification table still refuses UPDATE for its owner; and setBudget's birth check.

## Later update: 0553 restores the birth check (CI repair round 12)

FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet reviewed by a person. Check finding 1 of
round 12: 0552 removed the only database check that a retained row names, at birth, a referent of its
own tenant (the reviewer note above). The additive
`packages/database/migrations/0553_retained_referent_birth_guards_r12erasure.sql` (journal idx 113,
renumbered at merge if needed) puts that half back without the lifetime claim, and 0552 is not edited:

- One `BEFORE INSERT ... FOR EACH ROW` trigger per dropped column, `aa_retained_referent_birth_<column>`,
  on `lifecycle.require_retained_referent('<column>','<schema>','<table>')`. A non-null UUID that names
  no row of the target with the same `organization_id` is refused: `RETAINED_REFERENT_MISSING`, SQLSTATE
  `EN423` (previously unused), DETAIL the `schema.table.column`, never a value. A row with no
  organization that names a referent is refused too.
- One `BEFORE UPDATE OF <column>, organization_id` trigger, `aa_retained_referent_change_<column>`, on the
  nine columns of the four tables that can be updated at all (`budget_reservations`, `budgets`,
  `kill_switches`, `policy_bundles`); `usage_ledger` and `egress_decisions` refuse every UPDATE already.
  Only `kill_switches.released_by_membership_id` is granted to a runtime role (the release). An UPDATE
  that leaves the referent and the organization unchanged is not checked again, so a retained row whose
  referent was erased stays updatable in its other columns.
- No trigger on DELETE, and none on the referenced tables: erasure is unchanged and still ends with
  `leftOver: []` (L6 now also asserts the 28 triggers are enabled when it erases).
- The function is `SECURITY DEFINER`, owned by `ensemus_migrator`, `search_path=pg_catalog, pg_temp`,
  EXECUTE revoked from PUBLIC. Because the nine referenced tables are forced-RLS with tenant policies
  `TO ensemus_app` (the obstacle named above), each gets one SELECT policy for the migrator,
  `retained_referent_birth_probe`, admitting exactly the row whose `organization_id` and `id` equal two
  transaction-local selectors the function sets and clears, and only while a trigger runs.
- The `aa_` prefix makes the refusal fire before any other BEFORE ROW guard on these tables.
- It refuses exactly what the dropped FKs refused at birth, plus a referent named with no organization
  (MATCH SIMPLE skipped those; no writer produces one). It does not take the FK's KEY SHARE lock, so it
  proves the referent at birth, not until commit (see the reviewer notes in the migration).
- `setBudget` keeps its application read as a second guard; 0553 is the primary one.
- 0553 ends with a postcondition: every one of the nineteen columns has its enabled INSERT-only ROW
  trigger with no WHEN clause and the reviewed arguments, the nine change triggers exist, the function
  has exactly those 28 triggers, it is SECURITY DEFINER with the pinned search_path and no EXECUTE for
  anyone but its owner, and each probe policy is SELECT-only for the migrator with the one-row predicate.

Tests: `tests/integration/retained-referent-birth-guards.test.ts` (each of the nineteen columns, as
`ensemus_agent` or `ensemus_app`, refuses a never-existing UUID and another tenant's existing one with
EN423 and writes nothing; setBudget, the run's reserve/record/egress path, the knowledge model-job
principal, engageKillSwitch and releaseKillSwitch and an owner's policy bundle still write; a release
naming another tenant's or no person is refused; a row whose referent is gone stays updatable; the
catalogue shape; and the postcondition, rerun as the migrator, refuses a dropped, disabled, WHEN-gated or
re-aimed trigger, a dropped change trigger, a widened or dropped probe policy, EXECUTE for PUBLIC or a
runtime role, a changed search_path, SECURITY INVOKER, and the function on a DELETE trigger). Docker was
not available to the author: none of this has run locally.

## Not verified here

Docker was not available, so neither the migration nor either integration file has run. The FK names
and the guard inventory come from static enumeration of the migration sources; if the live catalogue
differs, 0552's first statement refuses with the differing FK in DETAIL rather than dropping anything.
