# Onboarding output inventory follow-up

Source follow-up to `f0e0568` on `codex/m5-onboarding`. This is not a runtime,
provider, migration or M5-completion claim.

The earlier status query applied current artifact readability before counting
outputs. A run with two actual outputs could therefore appear to have one output
after the other became inaccessible. There is no immutable final-output authority
that authorizes choosing the remaining visible output.

The gateway now enumerates all retained generated headers for the exact run,
Work and initiating viewer before evaluating readiness or viewer access. Pending,
blocked, abandoned, unlinked and deleted-history headers are not filtered from
the inventory. Mutable `bound`/`blocked` state cannot prove that a header was never
published. This intentionally refuses even some abandoned attempts until a real
final-output authority exists.

The bounded query returns at most two metadata rows: two prove ambiguity; no
latest or visible winner is selected. Multiple candidates produce an explicit
`artifactState: ambiguous` and no artifact identifiers. A sole header must still
be live, bound, settled, complete, untombstoned and readable with the exact saved
identity and Work link; otherwise its state is `unavailable` and no ID is returned.
An empty inventory is separately `none`.
The internal status contract requires this inventory state. A completed response
missing it is unavailable, so an older visible-only adapter cannot regain the
singleton fallback by returning one ID.

Completed-run advancement preserves explicit `BRIEF_AMBIGUOUS` or
`BRIEF_UNAVAILABLE` outcomes. The detail UI uses plain-language ambiguity wording.
Ordinary human uploads and unrelated attachments remain outside this inventory.
No schema, SQL, OAS, secret or provider/mode change is introduced.

The actual-role regression authors two generated artifacts through the real run
input inventory and writer protocol. An artifact-specific tombstone is inserted
under the actual tenant application role for the first output; no run input is
omitted and no physical byte-erasure claim is made. The first output must then be
unreadable while the second remains readable. The gateway must still report ambiguity and the
onboarding must stop without adopting either brief. This database test is authored,
not executed here.

The serialized source-check batch passed on this follow-up:

- `pnpm exec prettier --write` and `--check` on the seven changed TypeScript files;
  the evidence Markdown path is ignored by repository formatting policy.
- `pnpm exec eslint` on those same seven TypeScript files.
- `pnpm exec vitest run --project unit --maxWorkers=1` for
  `onboarding-run-port.test.ts`, `client-onboarding-activities.test.ts`,
  `client-onboarding-workflow.test.ts`, `client-onboarding-step.test.ts` and
  `tests/unit/onboarding-view.test.ts`: **5 files, 32 tests passed**.
- Sequential `pnpm --filter @ensemus/application typecheck`,
  `pnpm exec tsc --noEmit -p tests/tsconfig.json`,
  `pnpm --filter @ensemus/workflows typecheck`,
  `pnpm --filter @ensemus/worker typecheck`,
  `pnpm --filter @ensemus/web exec next typegen`, and
  `pnpm --filter @ensemus/web exec tsc --noEmit --incremental false`: all passed.

No failure or source fix occurred during this check batch. No installation ran.
The earlier 110-unit results belong to `f0e0568`; they are not added to this
32-test result. The new actual-role tombstone and missing-inventory regressions
were authored/typechecked only. All database, Temporal, browser, migration and
provider gates remain unrun for this follow-up.
