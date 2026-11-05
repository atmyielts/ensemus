# Security assurance, regulatory readiness, and incident response

## 1. Appropriate claims

Ensemus can design toward recognized assurance practices but must **not claim SOC 2, ISO 27001, GDPR compliance, or industry regulatory certification** until applicability, implementation, controls, audits, and legal review justify statements. NIST AI RMF and OWASP guidance are useful engineering references, not certifications.

## 2. Security development lifecycle

Threat model each new capability; security checklist in code review; dependency and container scans in CI; secrets scanning; SAST/DAST; schema and RLS verification; least-privilege connector reviews; pentests before major release; mandatory red-team cases for agent/tool changes; security regression tests as release gates. Track findings and residual risk acceptance.

## 3. Evidence collection

Policies/version approvals, key rotation records, encrypted backup tests, incident drills, vulnerability remediation, artifact signing, access reviews, log retention verification, deployment attestations, and independent audit results. Protect evidence from leaking real customer data.

## 4. Incident severity framework

**Critical:** confirmed cross-tenant leak, unauthorized external model transmission of restricted data, compromised signing key, widespread unauthorized tool actions.

**High:** suspected sensitive exfiltration, material authorization bypass, major unavailability of business-critical work.

**Medium:** bounded non-sensitive issue with mitigations; restricted operational degradation.

Detailed thresholds, customer notification times, and jurisdictions belong in legal/SLA policy and must be finalized before production.

## 5. Incident process

Detect → classify → isolate → preserve evidence → contain credentials/models/connectors/tool grants → assess tenants/data involved → patch/fix → validate → customer/legal notification under contract/law → recovery → postmortem and regression tests. The platform must support pausing all tenant agent execution, disabling a provider profile globally, and revoking a compromised connector without blocking core read-only operations unnecessarily.

## 6. Incident playbooks

- **Provider egress violation:** immediately disable route, collect egress decision/audit IDs, identify content classes and tenants, contact provider under contract, assess notification.
- **Compromised OAuth connection:** revoke tokens and service account, halt queued actions, reconcile recent side effects, rotate vault secrets, rebuild affected ACL projections.
- **Prompt-injection exploit:** disable affected skill/tool, preserve sanitized traces, patch policy/tool gateway, run red-team regression.
- **Sovereign package compromise:** issue signed advisory and patched offline bundle, provide compromise indicators and customer-controlled verification steps; never secretly alter on-prem installation.
- **Data deletion failure:** quarantine stale index/caches, block source retrieval, execute repair, disclose relevant exceptions.

## 7. Roles and accountability

Appoint incident commander, security lead, infrastructure lead, customer communication owner, and legal/privacy adviser. Maintain contact roster, escalation hours and evidence custody. For Sovereign, include customer operator responsibilities and precise vendor remote-access rules.
