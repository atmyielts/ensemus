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

An invitation carries the authority of the person who sent it, for as long as they have it. Disabling them, or taking away their right to invite, revokes their unaccepted invitations in the same transaction, and acceptance checks the inviter again under its lock. A disabled member cannot return through a new invitation.

An invitation is only for the address it was sent to, and that means something only once the address is proven. A verified account joins on acceptance. An account whose address nobody has verified, which today is every password account because the product sends no mail, only asks: someone who can invite has to confirm it on the people page. The link holder learns nothing until then. Being named as an approver is not an access grant either: approvals whose approver can no longer read the work are closed, and they leave that person's lists at once.

Work access comes from being the accountable owner or being assigned, and from nothing else. Whoever creates a Work Unit is assigned when it is created, so that access is listed on the page and can be removed like anyone's.

## 7. Audit record

Who (initiator + actual executor), organization, action, target ID, classification, policy version, decision, approval ID/hash, timestamp, correlation/causation, result external ID, safe reason, and append integrity reference. Avoid storing full confidential payload in default audit. Restrict audit viewers; export with integrity checks and redaction.

## 8. Break glass

Support or security emergency access must be explicit, time-limited, independently authorized where possible, and logged. For Sovereign, operator host control cannot be technically eliminated by application RBAC; operating contracts and encrypted key management must reflect the actual trust model.
