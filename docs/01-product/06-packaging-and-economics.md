# Packaging, pricing logic, and unit economics

Final prices are **TBD**; use validated cost models rather than guessed public price points. Marketing must distinguish subscription allowance, infrastructure fees, model provider bills, and maintenance.

## Pricing dimensions

- Organization tier: number of active humans, company teams, Work Units, platform storage, standard retention, permitted connectors, support availability.
- AI allowance in Cloud: included credits/weighted usage per billing period; rate-limited and subject to explicit top-ups. Track actual provider cost, projected completion cost, and margin.
- BYOM: platform fee based on seats/resources; no Ensemus token markup on a customer's direct provider bill. Platform execution and ingestion processing remain included or separately metered with published limits.
- Sovereign: one-time license fee calculated from deployment footprint, organization size band, authorized production/nonproduction environments, and distribution/support obligations. Maintenance separate, optionally renewable at contracted price; infrastructure always customer-funded.

## Entitlements model

Entitlements should be stored as structured policy/versioned snapshots per billing period: `max_active_members`, `monthly_platform_runs`, `storage_gb`, `integrations`, `feature_set`, `service_region`, `retention_class`, `support_level`, `ai_credit_balance`, `allowed_deployment_modes`. Separate feature permission from metering to avoid cutting off approved core work during a temporary provider outage.

## Cost formulas

- **Inference cost:** sum of input tokens × provider input rate + output tokens × output rate + cached/batch/media/tool costs, across all model calls used by a Work Unit.
- **Completed-outcome unit cost:** (model inference + embedding + reranking + extraction + workflow infra + egress + storage incremental + operator labor attributable) / verified completed Work Units.
- **Cloud gross margin:** subscription and approved top-up revenue minus inference, platform infrastructure, processing, support allocation, payment fees, and third-party charges.
- **BYOM gross margin:** subscription revenue minus platform services, support, connector/storage, observability and support costs (not customer-billed inference).
- **Sovereign contribution margin:** license and paid maintenance/professional service revenue minus contracted distribution, engineering, support, and third-party distribution obligations.

## Guardrails

- Per-org and per-agent hard budget ceilings, concurrent run caps, explicit max-cost estimates for complex work, and alert thresholds.
- Reject or require purchase for runs exceeding remaining Cloud allowance; never surprise-run an expensive autonomous flow.
- Meter provider-reported tokens, estimated cost, retries, and accepted outcomes; reconcile provider invoices for Cloud.
- Do not silently downgrade quality below published workflow standards to protect margin. Fall back only to pre-evaluated profiles.
- Monitor pricing/API changes for each provider; maintain dated rate cards and routing evaluations.

## Illustrative packaging (no prices)

Cloud Team: core work, included AI credits, standard connectors, shared support. Cloud Growth: expanded governance/quotas. BYOM Team/Growth: same workspace, own inference endpoints, published platform resource limits. Sovereign: licensed release, customer-managed hosting, optional deployment assistance, offline capable, maintenance separately contracted.

## Commercial risk review

Unmetered model workloads, unlimited document ingestion, large context defaults, uncapped recursive agents, third-party provider price changes, data residency commitments, and custom SLA clauses can create substantial liability. Pricing committee must sign off on provider utilization, fair-use terms, customer expectations, and support costs before publishing packages.
