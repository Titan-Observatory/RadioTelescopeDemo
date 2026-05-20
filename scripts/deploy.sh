#!/usr/bin/env bash
# Live deploy. Reads infra/deploy.env for host targets, then:
#   1. Builds the frontend bundle.
#   2. Rsyncs it to the caddy host's web root.
#   3. Pushes the live Caddyfile and reloads caddy.
#   4. Restarts radiotelescope.service on the Pi.
#
# nginx is never touched by this script; it's a set-and-forget SSL edge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
source infra/deploy.env

: "${CADDY_HOST:?CADDY_HOST must be set in infra/deploy.env}"
: "${PI_HOST:?PI_HOST must be set in infra/deploy.env}"
: "${CADDY_WEBROOT:?CADDY_WEBROOT must be set in infra/deploy.env}"

log() { printf '\n[deploy] %s\n' "$*"; }

log "Building live SPA bundle (dist/)"
(cd frontend && npm run build)

log "Syncing dist/ -> ${CADDY_HOST}:${CADDY_WEBROOT}/"
rsync -a --delete frontend/dist/ "${CADDY_HOST}:${CADDY_WEBROOT}/"

log "Pushing live Caddyfile to ${CADDY_HOST}"
scp "infra/caddy/Caddyfile.live" "${CADDY_HOST}:/etc/caddy/Caddyfile"

log "Validating and reloading caddy on ${CADDY_HOST}"
ssh "${CADDY_HOST}" "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"

log "Restarting radiotelescope.service on ${PI_HOST}"
ssh "${PI_HOST}" "sudo systemctl restart radiotelescope.service"

log "Live deploy complete. Tail /var/log/radiotelescope to confirm startup."
