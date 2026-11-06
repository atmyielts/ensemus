# ADR-026: Tombstones survive a database restore

**Status:** Proposed. Implemented in code on 2026-11-06. D2, D3 and D4 need review by the security owner, alongside ADR-024 D4.
**Date:** 2026-11-06
**Deciders:** Project owner; security owner for D2, D3 and D4.
**Backlog:** `LIFE-01`. The full drill across PostgreSQL, Temporal and the object store stays `OPS-02` in M6.

## Context

`LIFE-01` says deleted sources block retrieval at once, and that restore tests cannot bring them back. The first half was done. The second half had no answer, because `platform.tombstones` lives in the database it protects. Restoring a dump older than a deletion loses the tombstone and brings back the file's row, its name and its link to the work. If the bytes also survived (the store was rolled back too, or the purge had not finished), the file can be downloaded again.

This has to be settled before the first backup exists, since a backup taken earlier has nothing to re-apply.

## Decisions

### D1: A ledger outside the database, written through the outbox

Each tombstone also becomes one object in the object store, at `tombstone-ledger/v1/{organization}/{type}/{id}.json`. It holds IDs, a type and a time: `{v, organization_id, target_type, target_id, deleted_at}`. `@ensemus/domain/tombstone-ledger` refuses to build or read anything else, so a name has nowhere to go. Every key is IDs and a known type.

Deleting a file now also emits `tombstone.recorded` in the same transaction as the tombstone, with the artifact as the aggregate. Delivery is at least once, and the write is idempotent: the key is deterministic and an existing object is left alone. No code updates or deletes an entry.

### D2: The dispatcher writes it, with a credential that reaches only the ledger

**This extends ADR-024 D4**, where the dispatcher reaches PostgreSQL and Temporal only.

The dispatcher writes directly rather than starting a workflow, so `published` means the entry exists. That makes the outbox backlog the true measure of what a restore could not bring back. Going through a workflow would have meant `published` only says that a workflow started, and the real lag would be hidden in Temporal.

Its database role gains nothing, because event metadata is exactly an entry: `organization_id`, `aggregate_type`, `aggregate_id` and `occurred_at`.

It holds a separate object-store identity (`objects_ledger_*`) scoped to `Read:ensemus/tombstone-ledger/*` and `Write:ensemus/tombstone-ledger/*`. A stack test proves this identity cannot get, head, put, delete or list a customer's file, and that the same identity can reach the ledger. An operator using another S3-compatible store has to create the equivalent policy.

A store outage says nothing about the event, so it costs no attempts and the event never goes dead. It also holds up nothing else: only ledger entries need the store, so a new failure class, `partial_outage`, does not hold the batch the way a Temporal outage does. After a failure, ledger writes are refused for 30 seconds without asking, and each write gets one try with a 10-second request limit, the same as a Temporal call. So a store that hangs holds up Temporal signals for about 10 seconds in every 40. A shorter limit would fail needlessly: a new SeaweedFS store took over 4 seconds for its first write.

A store that answers slowly without ever failing does not trip that wait, so one batch also has a budget: once it has spent 10 seconds on ledger writes, the rest of its entries wait for their retry, as `partial_outage`. The write that uses up the budget can itself take up to 20 seconds (a check and a put), so a slow store holds up the signals behind it for at most about 20 seconds in a batch, and not one write after another.

A Temporal outage does not stop the ledger either. Entries use no Temporal call, so the rest of a batch being held does not hold them, and the dispatcher starts without waiting for Temporal, so it cannot end up restarting in a loop with entries unwritten.

### D3: An operator command re-applies the ledger

`node dist/reapply-ledger.js`, run from the worker image, reads every entry and for each one, per tenant through row-level security (the application role and a service context, so no new privilege):

1. Puts back the tombstone with its original time.
2. Removes the artifact row, which takes its links to work with it, and closes any open review that covered the file. A review that was holding its work ends as when a reviewer loses access: a plan's run fails, paused manual work stays paused, and the people relying on it are told.
3. Records that the bytes must go, deletes them, checks they have gone, and marks that done.
4. Writes one audit row (`artifact.deletion_reapplied`) if anything changed.

Step 3 follows the first transaction, as in an ordinary deletion. If the store refuses, access is already blocked, the row says the bytes still have to go, and the upkeep sweep or another run finishes it. Running it twice changes nothing. It prints counts and IDs, no names, and exits non-zero if an entry failed, was not valid or is waiting for a decision.

An entry for an organization the backup predates has its bytes removed and writes no rows: the foreign key would refuse them, and nobody can reach an organization that is not there.

**An entry is not proof of a deletion, so it cannot destroy a whole file by itself.** The dispatcher's credential can write any entry, for any tenant. Whoever steals it could otherwise name a live file, wait for the closed gate to prompt an operator to re-apply, and have the operator's credential destroy that file. So a file whose row and bytes both still exist is left untouched and reported as `unconfirmed`, and its tenant stays refused until an operator decides, per entry:

- `--confirm <entry>` says the deletion is real: a restore did happen, and the store went back with it or a purge had not finished. The entry is then applied as above.
- `--confirm-file <path>` says the same of each entry a file lists, for a restore where bytes survived and there are many. It is `--confirm` written down and nothing wider: every line has to be one exact entry, there is no pattern and no form for a whole tenant, and one line that is anything else stops the command before it has changed anything. An entry that is not named stays unconfirmed, so a forged entry can only destroy a file if an operator lists it. Nothing can check the list on the operator's behalf, and an operator who copies every entry the command reported has given that protection up, which the runbook says.
- `--quarantine <entry>` says it is not: the object moves to `tombstone-ledger-quarantine/`, which nothing reads as ledger and the ledger identity cannot reach, and an audit row records it. This is also the way to clear an object that is not a valid entry, which used to refuse its tenant with no way out. The entry can be given as an object key when its key names no entry.

A real deletion normally needs no decision, because its bytes went when it happened. Then believing the entry loses nothing but a row that points at nothing, and it is applied at once. Only the two cases the Context names, where bytes survive, reach a person.

**Why not a signature.** An entry signed with a key the dispatcher does not hold would prove more, and stop the gate closing too. But the dispatcher writes entries from event metadata and may see nothing else (D2), so the signature would have to travel through a new column of `domain_events` with a new grant, and web and worker would need a new long-lived secret, with key rotation for entries that are kept indefinitely. The rule above needs none of that. If the security owner wants forged entries refused outright, a signature is the next step, and it does not conflict with this.

### D4: The serving gate looks at the data

Nothing has to be remembered for the gate to work. A tombstone commits before its entry can be written and is never removed, so in ordinary running the ledger can only be behind the database. A ledger entry the database lacks therefore proves the database went back in time.

The web tier compares the two for a tenant after checking membership, in `requireTenant` and the `/api/v1` wrapper. While the database is behind:

- Pages, downloads and Server Actions redirect to `/restoring`, which answers 503.
- The API answers 503 `RESTORE_PENDING`, `retryable: true`.
- Someone outside the tenant still gets the usual 404, so the gate does not reveal whether an organization exists or is being restored.
- Other tenants are served. The gate needs no cross-tenant access, because a tenant's own tombstones are enough. That is also why it could be built without a new database privilege.

The gate opens by itself once the ledger is re-applied. A clear answer is remembered per tenant for 30 seconds and a closed one for 2 seconds. Starting a process forgets them, so a fresh web process refuses from its first request, as long as the store answers within the limit below.

**If the store cannot be asked, the gate stays as it was, or open if this is the first check, and logs `restore_gate.check_failed`.** Failing closed would turn any store outage into a full product outage. While the store is down no bytes can be served, but a deleted file's name could be listed. That is a deliberate trade the security owner should review.

**Requests wait for a check only so long.** A request, on any page or API call and not only those using a file, waits for a tenant's first check at most 2 seconds in all, however many pages the listing has, and for a later check at most 500 ms. Past that it gets the last answer, or open if there is none, `CHECK_TIMEOUT` is logged, and the check carries on behind it so that its result still counts. A check that failed or took longer than 500 ms makes the next ones run behind the requests, which get the last answer until one comes back within that time, and `CHECK_TIMEOUT` is logged for any of them past 2 seconds. So a store outage, or a store that is slow and still answers, costs each tenant one wait on each web replica, and not one every 30 seconds.

While the store is quick, the first request after an interval waits for the check, which is how it sees a restore however long the tenant has been idle. On a store slower than 500 ms it does not: the first request after an interval gets the last answer, however old, and those that follow get the new one as soon as the check ends. On a store slower than 2 seconds, or a tenant whose ledger takes longer than that to list, a fresh web process can serve for as long as its first check takes. This is the same trade as above. The runbook keeps the web tier stopped until the re-apply has finished, which is what closes that gap in a real restore.

## What this does not cover

- **Deletions that never reached the ledger.** If the database is lost while `tombstone.recorded` events are still queued, those tombstones are gone. The file's row and name come back, and re-applying cannot help. A stack test shows this happening. In ordinary running the window is one dispatcher poll (500 ms when idle). It has no upper limit during a dispatcher or store outage, though a Temporal outage does not cause one (D2), and it is visible:
  - `tombstone_ledger.backlog` is logged every minute while anything waits, with a count and the oldest age.
  - `node dist/ledger-backlog.js` prints the same on demand.
  - The bytes went at deletion unless the store was also down. So the usual outcome is a name without a file, and the worst case needs the database lost during a store outage.
  - Restoring over a database that is still running destroys its queue as well, by replacing the outbox. The runbook drains the backlog first, so this one is avoidable.
- **A running web tier.** Up to 30 seconds can pass between a restore and a running process noticing, which is why the runbook stops the web tier first.
- **Rolling back the ledger itself.** The ledger shares a store with the bytes. A store restore that also takes the ledger back loses entries, so `OPS-02` must keep the ledger out of any store rollback or restore it from its newest state. The code does not enforce this.
- **Tampering by someone with store administration.** Append-only here is what the code does, not what the store enforces. The web and worker identities are still store-wide administrators, and the ledger identity can technically delete inside its own prefix. Object lock and narrower identities belong with `OPS-02` and production store selection.
- **Forged entries, short of destroying a whole file.** The gate compares keys and reads no bodies, so whoever holds the ledger identity can refuse any tenant by writing one object, and it stays refused until an operator quarantines that object. They can also delete real entries, or replace one with a bad body. An entry naming a file whose bytes have already gone is applied without asking, which removes a row that could not be read anyway. An operator who confirms a forged entry destroys that file, so the runbook asks them to confirm only after a restore they know about. After a forgery, rotate `objects_ledger_*`, or the same credential can write it again.
- **The backup itself.** A dump still holds deleted names and rows until it expires. This stops them returning to the product, and does not erase them from backups. Backup retention is `LIFE-02`. The ledger stops short of that: it keeps IDs and times indefinitely until `LIFE-02` sets retention and `LIFE-04` covers offboarding.
- **Everything else a restore disturbs.** Work created after the backup is lost. Uploads made after the backup leave unreferenced bytes. Temporal may remember runs the database no longer has. Queued events in the dump are delivered again. Reconciling these is `OPS-02`.
- **Tombstones written before this change.** They have no ledger entry and there is no backfill, because no deployment is known to exist.
- **Other kinds of source.** Only files are tombstoned today. When search chunks, embeddings and memory arrive (M3 onward), they need their own type and re-apply step.

## Consequences

- **One new credential pair** for each deployment, and the dispatcher now depends on the object store's network. It already shares that network.
- **Each active tenant costs one listing and one query every 30 seconds, per web replica.** The cost grows with that tenant's lifetime deletions, at 1,000 keys per page. That is fine at this stage, and has not been measured under load. It will need another look alongside `LIFE-02`, and `OPS-01` should include it.
- **No migration and no workflow change.** The new event uses existing tables, and no history changes.

## Reversal

Remove the gate calls and the event handler. Existing entries are harmless. Tombstones in the database go on working as before.

## Approvals

| Role | Name | Decision | Date |
|---|---|---|---|
| Project owner | | | |
| Security owner (D2, D4) | | | |
