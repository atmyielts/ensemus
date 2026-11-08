# Payment source composition onto 6a913c6

This is a source-only integration report. Base `6a913c6` is the current root composition requested by the integrator. Preserved `codex/m8-payment-lookup-outcomes` remains at checked `789db4218fb55b1563abe02ae17e6c5b3ea0eef8`. Separate `codex/m8-payment-platform-current` composes the exact payment-only chain as one delta against 6a913c6:

```text
f21b4bf -> 2316ffc -> 5701649 -> 3738cd4 -> 789db42
git cherry-pick --no-commit 2316ffc 5701649 3738cd4 789db42
```

All four commits applied without conflicts. No older shared file was copied wholesale. The source delta contains 48 payment paths plus this report. Root changes from f21b4bf through 6a913c6 are retained, including the current native MFA/SAML principal handling, UI/workflow map, browser fixtures and delivery evidence. None of those 29 intervening root paths overlaps the payment delta.

## Shared composition

- Tenant transactions and the existing real-savepoint facade retain every prior clear/restore key, including native interactive identity, model/agent protocols, process intent/step, custom-object deletion, portability, standing, archive and delegated lifecycle selectors. Eight private payment selectors are added to both existing key sets:
  - `billing.payment_org`
  - `billing.payment_control_org`
  - `billing.payment_route_processor`
  - `billing.payment_route_identity`
  - `billing.payment_route_customer`
  - `billing.payment_target_org`
  - `billing.payment_target_account`
  - `billing.payment_webhook_token`
- Connector worker composition uses the actual native identity/lookup/webhook attesters and standing-owned adapter while retaining existing M3 verification/inbox/transaction behavior. No native processor, merchant identity, API origin, secret or provider is selected. Missing native configuration keeps dispatch unavailable.
- The platform worker receives the actual configured billing organization for original receipt routing and the existing real standing adapter. Signed accepted receipts retain their stable account/environment namespace and original execution/source authority across retry. Billing-disabled reconciliation does not authorize a new charge or release another stop owner's stop.
- Financial schema additions are additive to the current schema. Existing financial standing, native privilege, Work and source/run guards are retained. Cloud prepaid refusal remains; no provider/card/rate or financial enablement is introduced.

## Migration and inventory boundaries

0512 remains an authored, unregistered and unapplied migration. It now requires the actual strict `app.current_auth_restore_generation()` contract from 0422. Do not substitute a helper or run it against the current base before the genuine auth/material prerequisites are composed. The exclusive pending restore fixture requires its own isolated PG project, all its actual runtime connections drained before real begin, and reviewed 0515 material rotation. It leaves admission pending and never supplies a fake ack/cooldown shortcut.

Journal, schema snapshots, generated contracts, lockfile and the active 198-table portability inventory are unchanged by this join. The five unregistered tables remain deferred for explicit classification at actual reviewed registration:

- `billing.payment_identity_attestations`
- `billing.payment_execution_bindings`
- `billing.payment_customer_bindings`
- `billing.payment_webhook_bindings`
- `billing.payment_webhook_attestations`

These are retained financial/control lineage, not imported business/execution authority or disposable caches. Their exact financial retention/erasure contract and cross-tenant control FKs require separate qualification; this join adds no eraser permission or positive physical proof.

## Evidence and next gate

No checks, formatter, install, SQL, runtime, database, restore, browser, build, provider operation or activation ran on this integrated branch. The prior 789db42 checkout passed owned 44-TS/3-doc format, 44-TS lint, 92 units across 13 files and seven sequential noemit scopes, as recorded in [the lookup source evidence](M8-payment-lookup-operation-source.md). Those are historical source results, not verification of this new composition.

Next permitted source gate should cover the actual owned union, the same 13 focused unit files with one worker/no file parallelism and sequential saas/database/connectors/application/workflows/tests/actual-worker noemit. Fresh migration/role/schema qualification with actual 0422/material prerequisites is separate. All 0512 actual-role fixtures, native stop/drain, genuine post-ack old-generation/fresh-lookup refusal, concurrent driver barriers, provider contract/security review and Cloud prepaid acceptance remain open. No 0516 implementation is included.
