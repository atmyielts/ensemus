#!/usr/bin/env bash
# Run inside a fresh Codespace. Forward only port 8443 and choose its visibility separately.
# After startup, run this script with "setup-code" to issue a one-time account code.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode="${1:-start}"
case "$mode" in
  start|check|setup-code) ;;
  *) echo "Usage: bash $0 [start|check|setup-code]" >&2; exit 2 ;;
esac
[[ "$mode" == check || "${CODESPACES:-}" == true ]]
export ENSEMUS_HOSTNAME="${CODESPACE_NAME:?Codespace name required}-8443.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:?Forwarding domain required}"
[[ "$ENSEMUS_HOSTNAME" =~ ^[a-z0-9-]+\.[a-z0-9][a-z0-9.-]+$ ]]
export ENSEMUS_PUBLIC_URL="https://${ENSEMUS_HOSTNAME}"
export ENSEMUS_MODE=sovereign
export ENSEMUS_ALLOW_SIGNUP=false
export ENSEMUS_CONNECTORS_ENABLED=false
export ENSEMUS_MAIL_ENABLED=false
export ENSEMUS_TRUSTED_PROXIES=
export COMPOSE_PROFILES=
export ENSEMUS_TEMPORAL_MEMORY_LIMIT=1280M

revision="$(git rev-parse --short=8 HEAD)"
export ENSEMUS_WEB_IMAGE="ensemus/web:demo-${revision}"
export ENSEMUS_WORKER_IMAGE="ensemus/worker:demo-${revision}"

compose() {
  docker compose -p ensemus-demo -f infrastructure/compose/compose.yaml -f .local/codespaces-demo/compose.yaml "$@"
}

if [[ "$mode" == setup-code ]]; then
  curl --fail --silent --show-error http://127.0.0.1:8443/api/health/ready >/dev/null
  compose run --rm --no-deps --pull never -T migrate node dist/setup-token.js
  exit 0
fi

umask 077
mkdir -p .local/codespaces-demo
python3 - <<'PYTHON'
from pathlib import Path

base = Path("infrastructure/compose/proxy/Caddyfile").read_text()
site = "{$ENSEMUS_HOSTNAME:localhost} {\n\timport {$ENSEMUS_TLS_PROFILE:ensemus_internal_tls}\n"
replacement = """http://:8080 {
	# Only the same-origin request whose Origin Codespaces maps to its loopback address.
	@codespaces_same_origin {
		method POST PUT PATCH DELETE
		host localhost
		header Origin https://localhost:8443
		header Sec-Fetch-Site same-origin
		header X-Forwarded-Host {$ENSEMUS_HOSTNAME}
		header X-Forwarded-Proto https
	}
	request_header @codespaces_same_origin Origin https://{$ENSEMUS_HOSTNAME}
"""
forwarding = "\t\theader_up X-Forwarded-For {client_ip}"
assert base.count(site) == base.count(forwarding) == 1
proxy = base.replace(site, replacement).replace(forwarding, forwarding + """
		header_up Host {$ENSEMUS_HOSTNAME}
		header_up X-Forwarded-Host {$ENSEMUS_HOSTNAME}
		header_up X-Forwarded-Proto https
		header_up -X-Forwarded-Port
		header_up -Forwarded""")
Path(".local/codespaces-demo/Caddyfile").write_text(proxy)
PYTHON

cat > .local/codespaces-demo/compose.yaml <<'COMPOSE'
services:
  proxy:
    ports: !override ['127.0.0.1:8443:8080']
    volumes:
      - ../../.local/codespaces-demo/Caddyfile:/etc/caddy/Caddyfile:ro
COMPOSE
compose config --quiet
if [[ "$mode" == check ]]; then
  exit 0
fi

node infrastructure/scripts/generate-test-secrets.mjs
compose build worker
compose build web
compose up -d --no-build --wait --wait-timeout 300
curl --fail --silent --show-error http://127.0.0.1:8443/api/health/ready
