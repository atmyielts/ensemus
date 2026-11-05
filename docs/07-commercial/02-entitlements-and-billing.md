# Entitlements, metering, invoicing, and fairness

## 1. Entitlement domain model

`CommercialMode` (Cloud, BYOM, Sovereign), `PlanVersion`, `EntitlementSnapshot`, `UsageLedgerEntry`, `Budget`, `TopUp`, `InvoiceReference`, `LicenseCertificate`, `MaintenanceAgreement`. Separate **feature authorization** from **billing calculation** so financial state cannot override security or legal controls.

## 2. Cloud billing

Customer pays Ensemus a subscription including stated model allocation. At usage boundary, the system provides visible remaining credits, rate limits, and task cost forecasts. Extra usage is either disabled/queued or purchased via explicit top-up/upgrade. Track provider actual cost plus cache, retry, extraction, and worker costs. Never label unlimited model inference unless backed by a defensible fair-use policy.

## 3. BYOM billing

Customer pays Ensemus recurring platform fee for workspace, orchestration, integrations, storage and support. Model provider API expenses are billed **directly by customer's model provider** or borne by their private inference hardware. Ensemus can show estimated third-party token costs, clearly marked estimates and not booked as Ensemus-billed inference. Any extra platform execution/storage fees must be separately disclosed.

## 4. Sovereign billing

Initial one-time fee for a perpetual licensed version/footprint, no recurring platform usage fee. Optional maintenance support contract and separately negotiated professional services are additional. Customer directly pays all hosting, inference and external service costs. Offline local entitlement verification must not require ongoing payment confirmation to keep licensed version operating.

## 5. Metering integrity

Each usage entry has tenant, source work/run, idempotency key, meter name, quantity/unit, rate card version, billing period, commercial mode, reservation, finalization and correction status. Reconcile provider invoices and refunds, retries, aborted runs, and duplicate events. Budget reservations can prevent runaway spend, but must release unused capacity after cancellation and account for delayed provider invoices.

## 6. Entitlement evaluation order

Verify signed license/subscription → feature allowed → organization quota/budget → existing policy/authz → eligible provider profile → execute. Even an unlimited license grant cannot authorize an otherwise prohibited provider or tool. Distinguish "feature not licensed" from "policy denied" in admin diagnostics without exposing forbidden content.

## 7. Suspension / downgrade

Cloud and BYOM suspension handling follows executed terms, with reasonable export/retrieval and clear notice, subject to legal obligations. Sovereign license use must not silently terminate because maintenance expires. If a plan downgrades, protect data from destructive truncation: make excess features read-only or request remediation according to published policy.

## 8. Pricing approval process

Finance and product approve unit economics, usage caps, model rate changes, support allocation, gross margin, and fair-use language before public launch. Do not bake nominal USD prices into the architecture; use versioned plans and rate-card tables. Example entitlements appear in `specifications/examples/plan-entitlements.yaml`.
