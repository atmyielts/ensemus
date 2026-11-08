# Workflow map source checkpoint

Backlog: AGENT-09 / M7 workflow authoring, ADR-031 D7. This follow-up extends the real native workflow editor. It does not qualify workflow execution, model behavior or external delivery.

## Implemented source

- A deterministic map projects actual saved points and connections, with direction arrows, parallel paths and all-of joins. It never changes saved positions or invents executable points. Every saved array entry remains in the text alternative, including duplicate identities, unknown kinds, repeated edges, missing endpoints and cycles. Oversized definitions retain the complete list instead of drawing an unreadable diagram.
- Each visual or text point link reaches its actual native edit form. Keyboard links, an explicit point-list alternative, a contained scrolling viewport, full wrapped labels and existing semantic light/dark tokens are used. Native forms remain the editor, with no drag dependency or primary JSON editor.
- Saved unavailable point type, approval rule and evidence rule values receive explicit retained options. Missing assistant/action/connection selections retain the existing explicit unavailable choices. Nothing silently becomes a different selection. The point helper substitutes only the explicitly selected point before strict validation, so a selected legacy choice can be replaced without normalizing unrelated nodes, connections or their order. A different unsupported point still refuses the save.
- The exact orphan-connection repair requires a current native Studio author, a fresh readable draft, explicit confirmation, expected version, exact edge index/from/to, and the actual idempotent update service. It removes only a connection with neither endpoint present. It adds no API, SQL authority or external effect.
- With JavaScript, other form entries stay in the existing account-scoped, short-lived tab-memory draft book. A version advances only after the actual service response proves the isolated orphan removal; a concurrent or unknown change keeps the earlier expected version. Explicit discard/reload replaces kept entries. There is no automatic retry or router refresh that discards them.
- Without JavaScript, normal anchor navigation and native forms remain available. Repair warns the user to save other open forms before submitting, since a native submission reloads the document. No cross-form no-JavaScript preservation is claimed.

## Authored verification

- `tests/unit/graph-layout.test.ts`: 9 pure layout cases, including forks/joins, deterministic geometry, all-entry preservation, missing/duplicate identities, loops, unknown kinds, repeated edges, oversize handling, Unicode labels and bounded DAG invariants.
- `tests/unit/web-workflow-map-repair.test.ts`: 7 exact-removal, safe-version-rebase and explicit legacy-point replacement cases. Unrelated duplicate edges/order are preserved; another unsupported point still refuses the save.
- `tests/browser/specs/workflow-map.spec.ts`: 7 actual-HTTP/native-action journeys authored for JavaScript/no-JavaScript navigation, pending fields through repair and save, stale repair/conflict and explicit reload, native confirmation, unavailable approval retention, keyboard access, narrow/wide layouts, dark theme and axe.

## Actual validation

Fresh bounded source checks on `codex/m7-workflow-map`, based on `d0fa355`:

| Command/scope | Actual result |
| --- | --- |
| `node node_modules/prettier/bin/prettier.cjs --write` with the 13 changed TypeScript/TSX/CSS source/test files | Passed |
| `node node_modules/eslint/bin/eslint.js --max-warnings 0` with the 12 changed TypeScript/TSX files | Passed |
| `pnpm exec vitest run tests/unit/graph-layout.test.ts tests/unit/web-workflow-map-repair.test.ts tests/unit/web-process-studio-input.test.ts --maxWorkers=1` | 30 passed across 3 files (16 new cases, 14 existing) |
| `pnpm --filter @ensemus/application typecheck` | Passed |
| `pnpm --filter @ensemus/tests typecheck` | Passed |
| `pnpm exec tsc --noEmit -p tests/browser/tsconfig.json` | Passed |
| `pnpm --filter @ensemus/web typecheck` | Route generation passed; TypeScript failed on the same 3 inherited Studio mismatches below; no owned-file diagnostics |

The inherited diagnostics are `studio/agents/[draftId]/page.tsx:57` (`people.role` absent in this older base), `studio/reviews/[reviewId]/page.tsx:76` (old `FrozenSpec` versus actual snapshot-reader type), and `studio/reviews/page.tsx:22` (`subjectName` absent in this older base). Root has independently repaired these on its joined integration branch; this checkpoint does not overwrite those files or claim its local full web typecheck passed.

The serialized slot was released after the last type command. The 7 new browser journeys and actual native-action acceptance remain unrun. No install, database, Docker, build, browser execution or live provider call was made for this follow-up.

## Impact and remaining gates

No migrations, API/OAS changes, new secrets, configuration, global CSS or navigation changes. Cloud, BYOM and Sovereign share this local renderer/native form path; no new network dependency is added. Their runtime/browser qualification is still open. Privacy uses existing fresh Studio authority and the existing account-scoped tab memory; the map is computed only from the already-authorized saved draft. It is a definition map, never an execution-status claim.

Manual journey: create a workflow, add parallel work points and an approval join, follow each map link to its form, use the full point/connection list, and rehearse only after correcting compilation issues. For orphan repair, use an actual incomplete saved graph with a connection between two missing identities; type in another form, confirm removal, check that text remains, then save it. In another tab, change the draft before removal to exercise the conflict and explicit reload path.
