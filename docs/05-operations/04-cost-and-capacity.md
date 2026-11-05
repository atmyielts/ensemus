# Efficiency, cost controls, and capacity planning

## 1. Primary KPI

`Total operational cost / verified accepted Work Units`, measured by workload and tenant cohort. Supplement with median completion time, human correction minutes, failed-run cost, and customer-perceived value. Token savings are secondary if they degrade task success.

## 2. Cost ledger

Store usage IDs, org, Work Unit, Agent Run, model profile, input/output/cache tokens, unit price version, estimated/actual cost, infrastructure processor class, external tool cost, billable/absorbed flag, and reconciliation status. Never bill BYOM model inference as Ensemus-owned credits; customer provider charges appear as informational estimates if available and clearly labeled.

## 3. Optimization ladder

1. Direct SQL/rules before calling LLM.
2. Restrict accessible context and tool list to task purpose.
3. Route to lowest expected *successful task* cost among policy-eligible evaluated models.
4. Cache stable prompt prefix; batch nonurgent work; avoid duplicate extraction/reembedding.
5. Parallelize only independent read-only operations when cost and limits allow.
6. Limit child delegation and model turns; enforce per-org and per-run budgets.
7. Use streaming for experience, not as an excuse for unbounded reasoning.
8. Profile per-tenant queue utilization and split heavy background workloads.

## 4. Capacity profiles

Maintain performance test profiles for small (10–30), medium (31–150), and growing (151–300+) person companies plus multi-tenant aggregate load. Profiles specify documents, active clients/projects, Work Units, concurrent model calls, connected apps, and retention. Derive VM/node sizing from measured tests; do not publish unsupported hardware promises.

## 5. Infrastructure controls

Set DB pool limits, per-queue worker concurrency, cache TTL and bounded memory, ingestion quotas, object-store lifecycle policies, tracing sampling by policy, provider rate limits, and retry ceilings. Separate high-volume analytics/query projections from OLTP when measurements show contention. Self-hosted observability stacks can be resource-intensive; plan accordingly.

## 6. Financial risk dashboard

Show gross margin by Cloud plan, platform cost by BYOM customer, support burden by Sovereign release, high-cost tool and skill profiles, top failed workflows, price drift, and abnormal provider invoices. Trigger tenant-visible budget warnings before hard stops.
