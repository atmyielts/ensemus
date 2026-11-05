# Commercial licensing and maintenance terms — design outline (not legal advice)

## 1. Three separate customer agreements

**Cloud:** recurring SaaS agreement + service description + DPA as applicable + AI usage policy + subprocessor list + SLA/support terms.

**BYOM:** recurring SaaS agreement + platform terms + DPA as applicable + BYOM addendum clarifying customer provider accounts, data movement, credentials, model bills, and unsupported endpoints.

**Sovereign:** executed perpetual on-prem software license + deployment schedule + third-party notices + separately priced maintenance/support agreement + DPA only to extent Ensemus processes customer data during implementation/support.

## 2. Sovereign one-time license structure

Define customer legal entity, permitted subsidiaries, deployment sites, production/nonproduction limits, seat or organization size band, licensed software release, software components included, permitted modifications, license term **perpetual for the licensed version**, and whether transfer/escrow/source delivery rights exist. No automatic intellectual-property assignment, resale, sublicensing or white labeling; negotiate such rights separately if demanded.

A license purchase remains valid after support or maintenance lapses, subject to its original contractual license terms. **Maintenance is not a disguised subscription required to keep already licensed features operating.** Offline validation must work without ongoing phone-home or vendor dependency. An optional paid annual maintenance agreement may include specific security patches, defect fixes, upgrade entitlements, support response targets, knowledge-base access, and installation assistance.

## 3. Responsibility table

| Responsibility | Cloud | BYOM | Sovereign |
|---|---|---|---|
| Platform hosting/security updates | Ensemus | Ensemus | Customer/operator; Ensemus supplies updates if contracted |
| Inference accounts/fees | Ensemus | Customer | Customer |
| Model agreement/permissions | Ensemus, disclosed | Customer, verified routing | Customer |
| Data classification and user grants | Customer config, Ensemus enforcement | Same | Customer config + customer operation |
| Backup and disaster recovery | Ensemus under SLA | Ensemus under SLA | Customer unless additional services purchased |
| Maintenance | Included with SaaS | Included with SaaS | Optional separate paid service |
| Infrastructure bills | Included in SaaS price except disclosed limits | Included in SaaS price except disclosed limits | Customer pays |

## 4. Essential contract exhibits

Security schedule, processing/subprocessor schedule, provider risk matrix, support SLA, incident notification, permitted use, confidentiality/NDA, IP ownership, third-party OSS attribution, warranty and liability limits, export/delete assistance, maintenance renewal and end-of-support, governing law, dispute forum, change management, escrow (optional), and source code rights if any.

## 5. Third-party distribution rights

Do not promise that third-party proprietary components or models are bundled free. Audit redistributable OSS licenses (including any copyleft obligations), paid enterprise feature rights, container registry terms, model weights, and embedding/tokenizer licenses. Maintain SBOM and notices. Legal counsel should review actual distribution artifacts.

## 6. Maintenance lifecycle

Offer published supported branches and a clear patch/upgrade policy. Distinguish security hotfixes on a licensed line from access to major new releases—subject to negotiated maintenance terms. A lapsed customer may continue using the purchased version, but cannot assume free future upgrades or perpetual support. Provide explicit renewal/reinstatement process and compatibility matrix.

## 7. No secret telemetry rights by contract

Cloud/BYOM data use must be disclosed. Sovereign support does not confer general vendor access to customer data. Any support bundle, temporary access or diagnostics requires specific authorization and minimization. An offline installation should not embed hidden activation or usage reporting services.

## 8. Legal review required

This is a commercial design, not executed terms. Have qualified counsel adapt licensing, perpetual rights, privacy/data processing, model-provider dependencies, export restrictions, warranties, software taxes and local jurisdiction requirements before selling.
