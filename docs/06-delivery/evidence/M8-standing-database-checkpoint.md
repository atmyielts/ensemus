# M8 standing database checkpoint

On 2026-11-08 the isolated, disposable `ensemus-m7-source-gate` database applied **67 registered
migrations** from a fresh volume. The added independent migration is
`0511_standing_agent_stops.sql`; 0417/0419/0510, payment-binding follow-ups and final 0999 remain
unregistered. Original platform databases and unrelated Docker resources were untouched.

The generated snapshot has 196 modeled tables and chains to 0509. The live constraint-name audit
found zero missing constraints and zero renames. The active unpublished `/3` portability inventory
matches all 198 installed platform tables, with zero missing or unknown tables. Two prematurely
listed future 0417 authority tables were removed from that unpublished inventory; they must return
with the coherent authority migration and its explicit dispositions. The strict exact-table export
guard and published `/1` and `/2` contracts were preserved.

The selected real-role group passed **68 tests across eight files**: standing runtime, standing and
provisioning refusal, late-commit credit consumption, private financial/support reads, payment
webhook binding, entitlements, catalog and account exports. This includes actual agent logins and
forged-role negatives, same-transaction lifecycle birth, independent stop ownership, cancellation by
another native owner, and refusal-audit rollback. It is not the full historical database regression.

The first run had 31 passes, 12 failures and 21 skipped cases. It exposed an existing human MFA guard
blocking legitimate service standing transitions. The narrow repair accepts only a lifecycle-only
change with one genuine, unapplied, same-transaction standing birth; human MFA and native-agent
denials remain. A subsequent 62/67 run exposed the migrator's missing offboarding row-lock visibility
and incorrect audit assumptions. The lock-only policy has `WITH CHECK(false)` and preserves actual
native admission, original requester proof and current-owner cancellation. A stale fixture table
name was corrected after a 67/68 run. The final fresh run passed all 68, with no skips.

Account export testing additionally found a real pagination bug: an extension cursor lost its
section prefix and was incorrectly resumed as a core cursor. The prefix now survives every page.
All six account-export cases passed, including actual M6 sections, manifest/sealing, suspended-owner
download, native session freshness, changed-owner streaming refusal and no SQL transaction across
storage reads. Storage is the fixture's in-process store; this is not provider or background-worker
acceptance. Private-read history fixtures now use genuine stop/recovery transitions and finish in
active standing, so access negatives cannot pass merely because the company is suspended.

Logs retained locally: `.local-m8-standing-db-first.log`, `.local-m8-standing-db-repaired.log`,
`.local-m8-standing-db-final.log`, `.local-m8-standing-db-qualified.log` and the two intermediate
account-export logs. Ownership-checked reset proofs and generated schema/audit metadata are under
the ignored `.local` directory.

The full joined unit checkpoint passed **5,548**, with two explicit skips across 244 files; serial
workspace types passed. Current clean-build browser qualification remains open. Cloud inference
stays explicitly refused until actual atomic M8 prepaid holds cover main and Knowledge dispatch and
settle without duplicate debits. Positive trusted provisioning, original payment execution binding,
real providers, complete deletion/restore closure, operations and independent acceptance remain open.
