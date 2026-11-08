# Typed-record purge dispatch source

Source based on root `8570d6b`, on `codex/typed-record-purge-dispatch`. This checkpoint is authored,
unchecked source. It does not qualify migration0423, PostgreSQL role behavior, Temporal replay or
actual material/object cleanup. Existing0419/0514/0515 proof and lifecycle adapters remain authoritative.

## Behavior

- A genuine retained catalog birth already closed, live-to-dead catalog transition, or typed native
  tombstone appends `knowledge.record_purge_requested` and its outbox row in the same transaction.
  Kinds are exactly `work_unit`, `project`, `client`, `object_record`. There is no reconstructed read
  history, title, body, payload or model result. A tombstone without a native catalog identity does
  not request cleanup. Actual restricted eraser deletes do not introduce new outbox births during
  whole-tenant erasure; that lifecycle retains its separate proof/ordering.
- Dispatcher mapping checks the persisted event/outbox and current dead-or-tombstoned native identity.
  An arbitrary active-record event, wrong organization, missing header or missing catalog is not
  cleanup authority. The existing ledger-only `tombstone.recorded` handler is unchanged.
- Current closed-catalog keyset reconciliation repairs missing/old events or failed starts without
  fabricating historical events. Five returned targets per page, one page/minute, full cycles hourly.
  Its in-process cursor is only pagination; a crash safely rescans. It is not a completion/proof cursor.
  An unavailable scan stays unavailable rather than becoming an empty successful inventory.
- One stable Temporal identity per organization/kind/ID starts with `ALLOW_DUPLICATE`; a running
  execution remains running, and a completed/failed execution may be checked again. Unknown start
  responses propagate to durable outbox redelivery; recovery attempts continue past one failing start.
- New workflow histories retry fresh material/fence/hold/file/final proof with durable exponential
  one-minute to one-hour intervals. After20 passes, continue-as-new carries the capped backoff.
  Existing manually started histories retain the original one-pass decisions through a patch marker.
  No unconfirmed/failed/held/unknown-writer result is converted to completion. Timer cancellation
  propagates. Completed runs end; the current-state recovery cycle can catch later debt.

## SQL, roles and bindings

New **unregistered** `0423_record_purge_dispatch.sql`; no new table, column, index, journal, snapshot,
portable section or eraser inventory activation. Requires0419 and0422; root owns registration/order.

- `knowledge.request_closed_record_purge()` is a fixed-target closed-search-path trigger, PUBLIC
  execution revoked. It inserts only a restricted system metadata event and matching outbox row.
- `knowledge.record_purge_event_target(uuid,uuid)` and
  `knowledge.closed_record_purge_targets(uuid,text,uuid,integer)` are fixed SECURITY DEFINER functions
  owned by the migrator, require actual `session_user=ensemus_dispatcher`, and assert restore admission.
  Only dispatcher receives EXECUTE and schema USAGE. No new native body SELECT or catalog write grant.
  Metadata RLS scopes apply only to the migrator while inside these functions.
- Private transaction-local keys are `knowledge.record_purge_emit_event`,
  `knowledge.record_purge_dispatch_scope`, `knowledge.record_purge_dispatch_org`,
  `knowledge.record_purge_dispatch_event`. Every changed key is saved/restored on success and error.
  These are owner-function scopes, not caller authority or reusable tenant capability. Neither tenant
  clear map is changed: no new tenant/native identity binding is introduced; a raw app/agent custom
  GUC cannot acquire the migrator or actual dispatcher role.
- Both dispatcher SQL readers assert0422 admission. Missing/pending restore refuses. They return only
  IDs/kinds, never a material generation/byte absence certificate. Pure metadata MVCC is not a reader
  drain or remote-I/O cancellation claim. All destructive Activities still recheck current proof.

## Authored verification and open gates

Protocol/unit sources cover exact canonical identities, lost response/duplicate-running, continued
page progress, unavailable inventories, restore refusal, invalid/foreign metadata, strict keysets,
durable backoff, holds/late debt, bounded histories, cancellation and legacy patch behavior.

The real-role integration source covers actual client/project deletion without tombstones, native
Work tombstone, real object-record soft deletion, active/fake/missing/foreign event refusal, rollback,
dispatcher body/write denials, invalid cursors and scope restoration. It is **unrun** and needs the
full registered joined schema, actual roles and current admitted restore controller.

No format/lint/unit/type/SQL/integration/replay/build/browser/restore/install command has run for this
initial source checkpoint `28c1683`. Performance under populated closure inventories remains unmeasured.

## Bounded source gate after28c1683

All results below are from this checkout after the parent explicitly granted its exclusive source
slot. First attempt passed; no diagnostic failures, reruns, warnings or package installation.

- Pinned `node node_modules/prettier/bin/prettier.cjs --write` on the changed TypeScript paths:
  passed. Markdown follows the repository's existing formatter ignore. SQL was inspected as source,
  not parsed/applied by PostgreSQL.
- Pinned `node node_modules/eslint/bin/eslint.js --max-warnings 0` on all12 changed TypeScript
  paths: passed.
- `node node_modules/vitest/vitest.mjs run --project unit --maxWorkers=1 --no-file-parallelism`
  with exactly `packages/database/src/record-purge-dispatch.test.ts`,
  `packages/workflows/src/knowledge-record-purge-step.test.ts`,
  `packages/workflows/src/knowledge-record-purge-workflow.test.ts`,
  `packages/workflows/src/knowledge-purge-step.test.ts`,
  `workers/workflow/src/record-purge-dispatch.test.ts`,
  `workers/workflow/src/dispatch-errors.test.ts`: **53 passed across6 files**.
- Sequential `node node_modules/typescript/bin/tsc -p <scope>/tsconfig.json --noEmit`:
  `packages/database`, `packages/domain`, `packages/workflows`, `workers/workflow`, `tests`:
  **all five passed**.

The slot was explicitly released immediately after the last typecheck. Migration0423 remains
unregistered/unapplied. The new integration cases, actual least-privilege SQL behavior, real Temporal
replay/continue-as-new, cross-queue execution, populated performance and actual provider/object/restore
qualification remain open. These protocol doubles/SDK seams do not prove any of those gates.
