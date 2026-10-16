#!/bin/sh
# Runs Caddy. With local certificates (CADDY_GLOBAL_OPTIONS=local_certs), also
# publishes Caddy's root certificate to /trust so the API and worker trust the
# same HTTPS names the browser uses.
set -eu
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
pid=$!
trap 'kill -TERM "$pid"' TERM INT
if [ -n "${CADDY_GLOBAL_OPTIONS:-}" ]; then
  root=/data/caddy/pki/authorities/local/root.crt
  while kill -0 "$pid" 2>/dev/null && [ ! -f "$root" ]; do sleep 1; done
  if [ -f "$root" ]; then install -m 0644 "$root" /trust/root.crt; fi
fi
wait "$pid"
