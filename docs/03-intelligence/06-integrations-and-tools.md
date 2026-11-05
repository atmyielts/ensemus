# Connectors, tool gateway, MCP and side-effect safety

## Integration types

Native connectors (Google/Microsoft/CRM/accounting) support signed webhooks, incremental sync cursors, explicit OAuth scopes, source provenance, revocation, and typed operations. MCP may expose tools/resources, but is never automatically trusted. Direct REST calls are preferable for internal typed functions; adding an MCP hop is not mandatory.

## Tool gateway

`AgentRun → allowlisted tool manifest → input parse → principal/delegation + resource authorization → classification/egress check → approval policy → execute with idempotency → verify external receipt → audit + result`. Tool manifests declare input and output schemas, network target allowlists, side-effect level, retry rules, bounded timeout, sensitivity and owner.

## External callbacks

Next.js Route Handlers own public callbacks. Verify provider signature, timestamp, replay token, body size and tenant/connection mapping before enqueueing work. Keep HTTP callbacks short; durable follow-up is handled by outbox+workers. Never give customer agent unscoped arbitrary fetch to access instance metadata or private networks (SSRF).

## Connector lifecycle

Create connection → approved admin grants scopes → encrypt credentials in vault → bootstrap import → incremental event/sync → update ACL/index and source cursor → revoke/delete cleanup. Store only encrypted credential references in business tables. A connector credential should not be delivered to the model, user browser, run trace or untrusted skill.

## External action consistency

Persist an action intent + payload hash + approval (when required) → send with idempotency key where available → check result and external IDs → mark verified. Retried Temporal Activities reconcile whether the side effect already occurred. Human approval binds exact payload bytes/version rather than an unbounded permission to change arbitrary content.

## Sovereign

Integration packages deploy locally and can be disabled individually. Air-gapped installs must work with **no** external connector dependency; connectors requiring the internet are clearly unavailable, not silently simulated. Private customer endpoints require verified connectivity and explicit network allowlisting.
