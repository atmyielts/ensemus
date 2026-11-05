#!/usr/bin/env bash
# Runs every M1 gate from a clean stack, in order, and reports each result. Exits 1 if any failed.
set -u
cd "$(dirname "$0")/../.."

failed=0
gate() {
  local name="$1"
  shift
  local started=$SECONDS
  if "$@" >"/tmp/gate-$$.log" 2>&1; then
    echo "PASS  $name ($((SECONDS - started))s)"
  else
    echo "FAIL  $name ($((SECONDS - started))s)"
    tail -25 "/tmp/gate-$$.log" | cut -c1-200
    failed=1
  fi
  grep -E "^ +Tests |Outbound attempts|Control:|Signature:|Control,|no unreviewed|Checked [0-9]+|tickets:" "/tmp/gate-$$.log" |
    sed 's/^ */      /' | cut -c1-120
}

compose_files=(-f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml)
docker compose "${compose_files[@]}" -f infrastructure/compose/compose.airgap.yaml down -v --remove-orphans >/dev/null 2>&1

gate "format" pnpm format:check
gate "lint and import boundaries" pnpm lint
gate "typecheck" pnpm typecheck
gate "unit tests" pnpm test:unit
gate "backlog and traceability" pnpm check:backlog
gate "contracts match the spec" pnpm check:contracts
gate "licenses" pnpm check:licenses
gate "dependency audit (production, high and above)" pnpm audit --prod --audit-level high
gate "integration tests on real PostgreSQL" pnpm test:integration
docker compose "${compose_files[@]}" --profile test-oidc down -v --remove-orphans >/dev/null 2>&1
gate "air-gap control detects an attempt" node infrastructure/scripts/air-gap-gate.mjs --control
gate "air-gap: stack tests, zero outbound" node infrastructure/scripts/air-gap-gate.mjs --keep
gate "SBOMs and offline signature check" node infrastructure/scripts/build-release.mjs

rm -f "/tmp/gate-$$.log"
exit "$failed"
