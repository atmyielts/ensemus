#!/usr/bin/env bash
# Runs every gate, each from a clean stack, and reports each result. Exits 1 if any failed.
# .github/workflows/ci.yml runs the same list, and tests/unit/gates.test.ts fails if either misses one.
# Browser tests need Chromium's system libraries on this machine. CI installs those with --with-deps.
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
  grep -E "^ +Tests |^ +[0-9]+ (passed|failed)|Outbound attempts|Control:|Signature:|Control,|no unreviewed|Checked [0-9]+|tickets:|^OK: an approval" "/tmp/gate-$$.log" |
    sed 's/^ */      /' | cut -c1-120
}

compose_files=(-f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml)

clean_stack() {
  docker compose "${compose_files[@]}" -f infrastructure/compose/compose.airgap.yaml --profile test-oidc --profile connectors \
    down -v --remove-orphans >/dev/null 2>&1
}

# Integration, the air-gap gate and the browser tests all use project "ensemus", on the same addresses
# and port. What one leaves behind, data included, the next would pick up. So each starts from nothing
# and leaves nothing. The upgrade gate has its own project, addresses and port, and removes them itself.
fresh() {
  clean_stack
  "$@"
  local status=$?
  clean_stack
  return "$status"
}

browser_tests() {
  docker compose "${compose_files[@]}" up -d --build --wait --wait-timeout 300 &&
    pnpm --filter @ensemus/browser-tests exec playwright install chromium &&
    pnpm test:browser
}

connectors_tests() (
  export COMPOSE_PROFILES=connectors ENSEMUS_CONNECTORS_ENABLED=true
  docker compose "${compose_files[@]}" up -d --build --wait --wait-timeout 300 &&
    pnpm stack:slice-2 &&
    pnpm --filter @ensemus/browser-tests exec playwright install chromium &&
    pnpm --filter @ensemus/browser-tests exec playwright test specs/external-actions.spec.ts
)

manifest_is_current() {
  node docs/specifications/tools/regenerate-manifest.mjs && git diff --exit-code docs/MANIFEST.json
}

clean_stack
pnpm stack:secrets >/dev/null 2>&1

gate "format" pnpm format:check
gate "lint and import boundaries" pnpm lint
gate "route types" pnpm --filter @ensemus/web exec next typegen
gate "typecheck" pnpm typecheck
gate "unit tests" pnpm test:unit
gate "backlog and traceability" pnpm check:backlog
gate "contracts match the spec" pnpm check:contracts
gate "licenses" pnpm check:licenses
# Throwaway containers with no network, and no stack, so it needs no clearing either side.
gate "deployed proxy: forged address, trusted proxy, hostname" node infrastructure/scripts/check-proxy.mjs
gate "docs manifest is current" manifest_is_current
gate "dependency audit (production, high and above)" pnpm audit --prod --audit-level high
gate "workflow replay corpus" pnpm test:replay
gate "integration tests on real PostgreSQL" fresh pnpm test:integration
gate "air-gap control detects an attempt" fresh node infrastructure/scripts/air-gap-gate.mjs --control
gate "air-gap: stack tests and outages, zero outbound" fresh node infrastructure/scripts/air-gap-gate.mjs
# Only reads the images the air-gap gate built, so it needs no stack.
gate "SBOMs and offline signature check" node infrastructure/scripts/build-release.mjs
gate "browser tests in Chromium" fresh browser_tests
gate "connector effects, receipts and browser" fresh connectors_tests
gate "connector air-gap: relay only, zero outbound" fresh node infrastructure/scripts/air-gap-gate.mjs --connectors
# main holds only the specification so far. Drop --from once a release is on main.
gate "paused approval across a release upgrade" node infrastructure/scripts/upgrade-gate.mjs --from a603fc9

rm -f "/tmp/gate-$$.log"
exit "$failed"
