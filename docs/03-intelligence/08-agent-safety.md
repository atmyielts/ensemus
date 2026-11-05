# AI-specific safety architecture — policy beyond prompts

## 1. Threat model premise

The model is an untrusted probabilistic component. It may misunderstand tasks, hallucinate capabilities, follow malicious text embedded in external data, or produce unsafe tool arguments. Security control cannot rely solely on the system prompt or model's goodwill.

## 2. Enforcement hierarchy

**Infrastructure boundary:** containers, egress allowlists, database roles, secret stores, network isolation.

**Authorization boundary:** tenant policy, principal delegation, resource ACL, tool scopes, approved provider profiles.

**Execution boundary:** schema validation, bounded steps/time/cost, idempotency, approval hashes, cancellation, verifiers.

**Model instructions:** behavior specification and user experience only; never the sole security control.

## 3. Prompt injection

Treat documents, emails, websites, MCP results, customer notes, and model output as lower-trust inputs. Instructions embedded in these sources cannot change system policy, model provider, secret retrieval, network destination, or approval requirements. Separate data/evidence from executable instructions and test with adversarial examples.

## 4. Data exfiltration risks

Prevent secret-bearing content from reaching unapproved models or tools; tools execute under server-side identity and permitted destinations. Restrict external HTTP tools, email recipients, file exports, and arbitrary URLs. Detect suspicious outbound URLs and mass exports, but do not rely on classifiers as the only boundary. Require explicit approval for broad data exports.

## 5. Autonomous action risk

Category escalation requires published policy and often human review. The agent cannot self-approve or create a new tool grant. High-risk changes (deleting records, transfers, employee changes) default to disallowed. Approvals bind exact intended action parameters and expire; changed payloads invalidate approvals.

## 6. Memory poisoning

No direct write to verified company memory from arbitrary external documents or agent statements. Fact candidates require evidence, permission, provenance, contradiction checks, and high-impact review. Quarantine untrusted sources and enable correction/rollback of memory revisions.

## 7. Unbounded consumption

Use token, cost, step, child delegation, tool request, elapsed time, storage and ingestion quotas. Apply organization-wide concurrency ceilings and alert on anomalies. Cross-agent recursion has explicit depth/budget propagation.

## 8. Safe coding / browser skills

Run code in sandbox without secrets or unrestricted network. Browser automation is potentially destructive and may encounter hostile pages; restrict domains, service accounts, outbound actions, downloads and permitted file paths. Tool server trust and package supply-chain checks are mandatory.

## 9. Human accountability

For sensitive decisions, the system offers recommendation and evidence rather than irreversible automated decision. Record approver identity, policy, exact payload hash, outcome receipt, and audit reason. Administrative overrides are break-glass, time-limited, and reviewed.

## 10. Red-team tests

Test: malicious Google Doc asking to export secrets; cross-tenant client name collisions; poisoned MCP tool descriptions; rogue agent that tries to switch model to public provider; social-engineered approval content changes; recursive delegation spend explosion; stale ACL and cached source; unknown external send status; forged webhook. See threat register and QA matrix.
