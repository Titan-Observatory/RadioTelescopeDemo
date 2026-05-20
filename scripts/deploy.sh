#!/usr/bin/env bash
# Single-switch deploy. Reads infra/deploy.env to learn DEPLOY_MODE
# (pre-launch | live) and the host targets, then:
#   1. Builds the right frontend bundle.
#   2. Rsyncs it to the caddy host's web root.
#   3. Swaps in the matching Caddyfile and reloads caddy.
#   4. Starts or stops radiotelescope.service on the Pi.
#
# nginx is never touched by this script — it's a set-and-forget SSL edge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
source infra/deploy.env

: "${DEPLOY_MODE:?DEPLOY_MODE must be set in infra/deploy.env}"
: "${CADDY_HOST:?CADDY_HOST must be set in infra/deploy.env}"
: "${PI_HOST:?PI_HOST must be set in infra/deploy.env}"
: "${CADDY_WEBROOT:?CADDY_WEBROOT must be set in infra/deploy.env}"

log() { printf '\n[deploy] %s\n' "$*"; }

build_and_sync() {
  local mode="$1"
  if [ "$mode" = "pre-launch" ]; then
    log "Building static teaser bundle (dist-static/)"
    (cd frontend && npm run build:static)
    log "Syncing dist-static/ → ${CADDY_HOST}:${CADDY_WEBROOT}/"
    rsync -a --delete frontend/dist-static/ "${CADDY_HOST}:${CADDY_WEBROOT}/"
  else
    log "Building live SPA bundle (dist/)"
    (cd frontend && npm run build)
    log "Syncing dist/ → ${CADDY_HOST}:${CADDY_WEBROOT}/"
    rsync -a --delete frontend/dist/ "${CADDY_HOST}:${CADDY_WEBROOT}/"
  fi
}

swap_caddy_config() {
  local mode="$1"
  log "Pushing Caddyfile.${mode} to ${CADDY_HOST}"
  scp "infra/caddy/Caddyfile.${mode}" "${CADDY_HOST}:/etc/caddy/Caddyfile"
  log "Validating and reloading caddy on ${CADDY_HOST}"
  ssh "${CADDY_HOST}" "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
}

case "$DEPLOY_MODE" in
  pre-launch)
    build_and_sync pre-launch
    swap_caddy_config pre-launch
    log "Stopping radiotelescope.service on ${PI_HOST}"
    ssh "${PI_HOST}" "sudo systemctl stop radiotelescope.service || true"
    log "Pre-launch deploy complete."
    ;;
  live)
    build_and_sync live
    swap_caddy_config live
    log "Restarting radiotelescope.service on ${PI_HOST}"
    ssh "${PI_HOST}" "sudo systemctl restart radiotelescope.service"
    log "Live deploy complete. Tail /var/log/radiotelescope to confirm startup."
    ;;
  *)
    printf 'Unknown DEPLOY_MODE: %s (expected pre-launch | live)\n' "$DEPLOY_MODE" >&2
    exit 1
    ;;
esac
