# Compiler structured reads: separable source checkpoint

This follow-up to 0214 records the actual M5 compiler and verified-fact structured reads before material leaves their transactions. It introduces no migration, model purpose, budget or ledger schema change.

The metadata-only run observation functions now live in `ai/input-observations.ts`; `ai/input-ledger.ts` preserves its existing exports and privately owns transcript erasure. The compiler imports the metadata module, which has no private-payload query. Run-bound compilation requires the actual branded agent context, matching run ID and target Work; a user cannot claim an agent run, and an agent cannot select the ordinary-answer evidence-shedding path.

The compiler hashes the actual original target Work task fields while reading them. `verifiedFactsFor` accepts an internal capture callback, with no public FactView/DTO field. Its subject reader collects hashes, IDs and classes from the actual Work/project/client rows already read, including the actual private client parent of a project. After every subject body lock is acquired, the same transaction records sorted observations through `recordRunInputs` before returning material. It does not reconstruct parents after the read, copy names into metadata or invent unread parent hashes.

The final compiler return rechecks the current named viewer against all durable inputs. Historical hashes remain provenance; routine mutation does not become a live equality gate. A retained old private parent continues to constrain reuse after a project is reparented to public material.

Two real-role cases are added to the existing protocol suite: actual verified project facts retain the original parent/hash across reparenting and fresh reader revocation; mismatched run and user-claimed run compilation refuse before routing. These cases are authored but unexecuted. The previous 0214 checkpoint's 221 passing units and six passing typechecks predate this follow-up and are not presented as fresh evidence for it.

In the parent-released tiny source slot, scoped Prettier write and `eslint --max-warnings 0` passed on the five owned TypeScript files; application and integration-tests noemit typechecks passed sequentially. No unit, database, Docker, build or provider command ran for this follow-up. The genuine embed/rerank/answer model-job bridge and 0216 accounting/qualification changes are separate work and remain open.
