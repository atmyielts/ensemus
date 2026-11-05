# Commercial modes: deployment, model ownership and support responsibilities

## Contract matrix

| Dimension | Ensemus Cloud | Ensemus BYOM | Ensemus Sovereign |
|---|---|---|---|
| Revenue from customer | Recurring platform subscription with explicitly stated included AI allotment | Recurring platform-only subscription | One-time perpetual release license; optional annual/term maintenance |
| Ensemus billing for inference | Included credits / authorized top-ups; terms must be explicit | No inference pass-through by default | No inference charge from Ensemus |
| Model supply | Approved Ensemus provider profiles | Customer keys/private inference subject to approved egress/networking | Customer keys/private local model |
| Hosts Node web/workers | Ensemus | Ensemus | Customer |
| Holds infrastructure secrets | Ensemus vault, least privilege | Ensemus vault for customer BYOM credentials | Customer vault/KMS |
| Holds business records | Ensemus-hosted under data terms | Ensemus-hosted under data terms | Customer-controlled |
| Persistence / backup | Ensemus contractual operator | Ensemus contractual operator | Customer unless service purchased |
| License validation | SaaS online service | SaaS online service | Offline signed perpetual certificate, no heartbeat |
| Support/update | Subscription scope | Subscription scope | Per purchased maintenance (separately negotiated) |
| Continued use if maintenance ends | Subscription terminates per agreement | Subscription terminates per agreement | **Purchased version continues operating** |
| Transfer, white label, source ownership | Not implied | Not implied | **Not implied** by perpetual license; separate contract |

## Specific IP and vendor restrictions

Sovereign 'wholesale' in product language means a perpetual right to run a specified release/footprint; it does **not** automatically transfer intellectual property, model weights, vendor subscriptions, redistribution rights, or source code. Those rights require explicit terms, legal review and third-party license compatibility. Maintenance expiration cannot remotely lock purchased software.

## Data confidentiality and provider responsibilities

Customer selects governance policies and authorizes users/connectors/providers. Ensemus enforces technical restrictions in SaaS; customers operate the controls in Sovereign. BYOM customer's provider receives whatever content is explicitly permitted by classification/region and provider terms; customer model ownership does not mean Ensemus SaaS never sees plaintext. Restricted content defaults to no external inference. No diagnostics contain raw secrets or documents by default.

## Product parity contract

Same Work Unit semantics, agent manifest formats, policy checks, data import/export and core UX. Differences allowed only in hosting, local provider availability, external integrations, licensing/billing and support. CI tests shared behavior in all modes; edge capability differences are documented.

## Legal status

This document is the intended commercial/technical architecture, **not an executed licensing agreement or legal opinion**. Counsel and procurement must finalize governing law, software redistribution terms, OSS obligations, payment taxes, liability, privacy, support SLAs and warranty scope.
