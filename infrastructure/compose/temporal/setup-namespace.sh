#!/bin/sh
# One-shot job: waits for the server, then creates the namespace if it is not there yet.
# Retention limits how long workflow history stays in Temporal's database.
set -eu
# passthrough skips gRPC's SRV lookup for an internal name, which goes outside and hangs when offline.
export TEMPORAL_ADDRESS=passthrough:///temporal:7233
attempt=0
until temporal operator cluster health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 90 ]; then
    echo "Temporal did not become healthy" >&2
    exit 1
  fi
  sleep 2
done
temporal operator namespace describe --namespace default >/dev/null 2>&1 ||
  temporal operator namespace create --namespace default --retention 72h
