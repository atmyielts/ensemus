# Agent input runtime binding: source checkpoint

0214 binds the real M4 context, tool writer and agent worker to 0208/0211 provenance (AGENT-07/15, KNOW-05, ADR-028 FD-3/5/17 and ADR-029 D3). This checkpoint adds source and authored regression coverage. It does not claim a migration, database, replay, browser, provider or production acceptance gate.

## Exhaustive reads and rolling deployment

Every new run receives a fixed-trigger checkpoint at birth. Legacy run histories remain `history_complete=false`; a target Work observation cannot silently upgrade them. `ContextSource` records actual Work IDs, task-field hashes and classes before returning Work material. A verified text-file read is followed by fresh Work/file/hash checks and a durable observation commit before returning its text. The ledger spans all turns and tools, including OTHER Work reads, checked citations and files omitted by the compiler for size. Model-selected citations and current assembly trace entries do not define exhaustiveness.

Historical mutable record hashes are retained rather than compared to a live body. Immutable artifact hashes must agree. All actual SQL evidence packages for the run remain independently included by the provenance service and fresh transcript/dispatch checks. Parent/project bodies are retained only when actually read; metadata-only authorization/class dependencies do not invent parent hashes. The minimal compiler reads no parent body. Root's M5 compiler binding must call `recordRunInputs` for its actual additional structured/fact-subject reads before returning model material.

The branded `AgentContext` transaction binds `app.agent_input_protocol=v1`; every other transaction entry clears it, including unbound, user, service, run lookup and webhook contexts. This is a trusted immutable-runtime version fence, not authentication by a string. SQL requires the actual agent role, exact run/initiator, active membership, birth-complete unfenced checkpoint and protocol admission before model/tool execution-step INSERT **and retry UPDATE**. An older bundled worker cannot reuse a new worker's in-flight step and then consume untracked material. Payload INSERT, generated begin/publication and run-bound allow-egress rows use the same durable fence. Legacy incomplete histories fail closed.

Actual agent composition performs a fresh all-input dispatch check immediately before the existing model gateway. The gateway still owns its approved routing, usage reservation, egress and provider protocol. Fresh ACL/class/deletion checks remain named-viewer checks; service inspection cannot replace the initiator. Transcript loads also recheck every observed record/artifact and every SQL package source. A private input's routine status/title change does not revoke access, while deletion, revocation or a class above the run's protection closes reuse.

## Once-only generated writes

The real `ToolStepStore` uses `GeneratedArtifactProvenance.beginInTx` before upload registration or object I/O, and publishes the same token in the artifact/link/output transaction. `ai.run_output_writes` durably admits exactly one `registered -> started -> settled` transition for an exact artifact/run/write ID/generation. A duplicate or resumed `putDraft` cannot issue another request. Only a fulfilled promise records `settled`; rejected/unknown puts remain `started`, even if HEAD is absent.

Publication requires a matching settled receipt. A late run fence may allow the already-fulfilled request's metadata settlement, but cannot allow publication. The exact-token fulfilled-put failure helper preserves a possibly committed bound file after a lost acknowledgement; otherwise it records a settled blocked header and durable tombstone. It is never called for a rejected/unknown put. There is no ordinary/human downgrade.

The actual M2 checklist Activity now calls the deterministic template adapter. That adapter verifies the exact approved template identifier, actual Work/Temporal hold and exact generated output hash; its explicit inventory contains only the authoritative Work observation. It cannot attest a different template, caller body, agent run or generic empty input list. Existing bound matching template output may be reused by metadata identity; a filename alone cannot make a human upload generated evidence. The service receives no new serving bypass. An active prior upload is refused rather than blindly overwritten.

## Transcript erasure and receipts

The real `RunTranscriptPurge` is registered only in agent-worker. It requires the actual agent database role and a branded service context, durably fences sorted exact run IDs, deletes their private payloads and counts remaining rows. Payload replacement takes the checkpoint lock **before** touching existing payload rows; purge takes that same lock first. Late model completions are discarded after a fence while their already-settled usage and turn counters are preserved.

The agent purge transaction records a durable payload certificate only after actual existing-run validation, permanent fence and actual zero payload count. SQL independently rechecks zero using the agent role's existing private-payload capability, stamps the server time and pins `purged_fence_generation` to the permanent fence generation. The receipt and fence are immutable. A legacy input-history-unknown run may receive this payload-only certificate after positive deletion; its history remains unknown. Missing/unfenced runs receive no receipt. This certifies payloads, not unknown input inventories or object requests.

Source purge's run enumeration now includes actual package runs, uncited source-bearing artifact reads and conservative legacy unknown histories. It no longer assumes package rows alone describe all model material. Source-close locks precede checkpoint locks; no model/object call holds a database transaction.

## Restricted eraser composition

New retained metadata relations are `ai.run_input_checkpoints`, `ai.run_input_observations` and `ai.run_output_writes`. Input observation/checkpoint DELETE requires the matching immutable payload certificate. Output-writer DELETE uses the existing `knowledge.certify_artifact_erasure` positive physical receipt and must precede its retained lineage header. No transcript receipt is an object quiescence proof.

Root must extend 0999's existing restricted eraser discovery, append-only accommodation and dependency ordering to these three relations. If the eraser role is provisioned after 0214, repeat the exact metadata-only checkpoint SELECT columns (`organization_id`, `run_id`, `fenced_at`, `fence_generation`, `payloads_purged_at`, `purged_fence_generation`), tenant-scoped receipt SELECT policy and `EXECUTE ai.certify_run_payload_erasure(uuid)` grant recorded conditionally in 0214. Preserve the existing separate `knowledge.certify_artifact_erasure(uuid,boolean)` eraser capability. No private-payload SELECT, BYPASSRLS or blanket trigger disabling is added.

## Authored coverage and actual validation

Pure inventory tests cover incomplete/fenced/missing target histories, mutable rereads, conflicting immutable hashes, malformed/unbounded observations and fixed fence-code recognition. Exact checklist tests cover fixed output language and refused actor/template shapes. The Activity lifecycle unit adds late-response usage preservation.

`ai-input-protocol.test.ts` authors thirteen real-role/runtime cases: OTHER Work revocation, historical mutable hashes, mid-read fence, rolling old-worker new/retry denial, protocol clearing, immutable actual-zero certificates and app denial, foreign run refusal, pre-put publication denial, duplicate claims including concurrent in-flight claims, late fence after fulfilled put, rejected unknown upload, lost SQL acknowledgement and uncited artifact-source transcript purge. Existing provenance and AI fixture helpers now use actual run/agent context and durable reads rather than synthetic random execution IDs or unbound private payload writes.

In the parent-released serialized source slot:

- `pnpm install --offline --frozen-lockfile --ignore-scripts` passed: ten packages reused, zero downloaded; the existing lockfile stayed unchanged.
- Owned TypeScript/JSON/ESLint config Prettier write/check and `eslint --max-warnings 0` passed. SQL and evidence Markdown are excluded by the repository formatter configuration.
- `pnpm exec vitest run --project unit` with the input-ledger, checklist-template, context-source, compiler, tool-gateway, Activity lifecycle and structured-input files plus `--maxWorkers=1`: **7 files / 221 tests passed**, 4.64 seconds.
- Sequential `pnpm exec tsc --noEmit -p` checks passed for database, application, agent-runtime, workflows, worker and tests.
- A final source-order/type cleanup rechecked inventory/checklist units (**2 files / 10 tests passed**, 1.65 seconds), application noemit, owned format/lint and `git diff --check`; all passed.

The first focused unit pass exposed an owned fence-code classifier mismatch between direct and Drizzle-wrapped SQL errors; both explicit EN119 forms are now covered. The first application typecheck exposed a checklist readonly-array narrowing issue, which was fixed before the green sequence. No migration apply, Docker, database, build, provider, replay or browser command was executed for this runtime change.

No new secret or commercial configuration is introduced. The protocol binding is transaction-local runtime metadata. Cloud/BYOM/Sovereign use the same source implementation and existing private agent queue; per-mode runtime/offline acceptance remains outstanding.

## Remaining acceptance gates

- Root owns the M5 model/embed/rerank/answer compiler bridge, full egress composition and actual knowledge model worker registrations. Record its actual additional structured reads using the exported ledger seam; this checkpoint does not claim that bridge is bound.
- Root owns migration registration/snapshots and fresh/upgrade SQL execution. Exercise the older-runtime protocol across immutable worker versions and a pre-0214 run whose history remains false; prove a payload-only legacy certificate does not change that fact.
- Compose and run the actual M8 legal-hold/storage lifecycle. The current S3 adapter has no generation fence. Unknown puts therefore remain unconfirmed; a request timeout, elapsed lease, missing worker or absent HEAD cannot become positive object proof.
- Run the real-role protocol, provenance, context/tool, source purge, private-payload, same/cross-tenant and M2 checklist journeys, plus joined eraser denial/success ordering and concurrent payload/fence/late-provider cases. Existing SQL repairs and parent-owned 0215 schema alignment must be composed, not overwritten.
- Run full integration/replay/browser/offline gates after the joined source has passed focused verification. This document remains a source checkpoint until those outcomes are recorded.
