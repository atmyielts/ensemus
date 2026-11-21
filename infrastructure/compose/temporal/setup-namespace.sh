#!/bin/sh
# One-shot job: checks the retention setting, waits for the server, then creates the namespace or brings
# the one already there to that setting.
# Retention limits how long workflow history stays in Temporal's database. ADR-037 D6: 72 hours is a
# technical default, not a promise, and no safety property may depend on it.
set -eu
# passthrough skips gRPC's SRV lookup for an internal name, which goes outside and hangs when offline.
export TEMPORAL_ADDRESS=passthrough:///temporal:7233

# Not ":-": a setting that is there and empty is a mistake to report, not a request for the default.
retention=${ENSEMUS_TEMPORAL_RETENTION-72h}

# Only names the setting, because a value that failed this is not known to be fit to print. Patterns, not
# a numeric test, so that no length of digits can make the shell complain and repeat it.
refuse_retention() {
  echo "ENSEMUS_TEMPORAL_RETENTION must be whole hours of at least 24, written <n>h" >&2
  exit 1
}
hours=${retention%h}
case $hours in
  # With no h to remove, or anything but ASCII digits left once it has gone.
  "$retention" | *[!0123456789]*) refuse_retention ;;
  # Every digit is ASCII by here, so these ranges cannot depend on the locale. No leading zero.
  2[4-9] | [3-9][0-9] | [1-9][0-9][0-9]*) ;;
  *) refuse_retention ;;
esac

attempt=0
until temporal operator cluster health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 90 ]; then
    echo "Temporal did not become healthy" >&2
    exit 1
  fi
  sleep 2
done
if temporal operator namespace describe --namespace default >/dev/null 2>&1; then
  temporal operator namespace update --namespace default --retention "$retention"
else
  temporal operator namespace create --namespace default --retention "$retention"
fi
