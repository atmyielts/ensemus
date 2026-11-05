# Authorization, service identities, approval chains, and audit

## 1. Effective permission rule

For a tool action, effective permission is the intersection of: organization policy × initiating principal's delegated rights × agent version grants × resource ACL × tool capability × data egress policy × risk state × active entitlements. No one source independently grants unrestricted access.

## 2. Policy decision contract

```json
{
  "principal": {"kind": "agent", "id": "agent_service_id"},
  "initiator": {"kind": "membership", "id": "member_id"},
  "organization_id": "org_id",
  "action": "email.send",
  "resource": "draft_id",
  "destination": "approved_connection_id",
  "data_classification": "confidential",
  "action_hash": "sha256-of-canonical-proposal",
  "context": {"business_purpose": "client_kickoff"}
}
```

A decision returns `allow`, `deny`, or `require_approval`; reason and policy version; obligations (redact, limit recipients, expiry, named approver); and audit ID. Deny takes precedence over allow.

## 3. Role model

Viewer/contributor/manager, workspace admin, connector admin, model admin, agent publisher, security steward, billing admin, Sovereign operator, and emergency break-glass. Role permissions should be data-driven but centrally validated. Grant changes require authorization and recorded change evidence.

## 4. Approval mechanics

An approval request snapshots exact tool name/version, canonical payload digest, target account, affected resource IDs, data class, side effect severity, approver policy, expiry, and trace/run ID. Reviewer sees human-readable diff and original evidence. After approval, gateway rechecks current policy, recipient/target, action hash, and token validity. Editing payload or revocation invalidates approval.

## 5. Delegation

A manager may delegate bounded tasks to an agent, but an unattended workflow needs a service identity with its own periodic review. Time-limited grants and caps propagate to children. Agents cannot create or extend grants through model instructions. Model provider accounts are separate resources with their own routing permissions.

## 6. Access review and revocation

Membership disable, project ACL change, or connector revoke should block new reads and writes immediately, cancel/hold affected active runs, invalidate cached contexts, and start index/cache repair. Conduct periodic access reviews and retain proof of review according to policy.

## 7. Audit record

Who (initiator + actual executor), organization, action, target ID, classification, policy version, decision, approval ID/hash, timestamp, correlation/causation, result external ID, safe reason, and append integrity reference. Avoid storing full confidential payload in default audit. Restrict audit viewers; export with integrity checks and redaction.

## 8. Break glass

Support or security emergency access must be explicit, time-limited, independently authorized where possible, and logged. For Sovereign, operator host control cannot be technically eliminated by application RBAC; operating contracts and encrypted key management must reflect the actual trust model.
