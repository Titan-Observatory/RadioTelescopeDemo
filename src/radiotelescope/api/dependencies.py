"""Shared FastAPI dependencies for auth/session gating."""

from __future__ import annotations

import ipaddress
import logging
from typing import Iterable

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, URLSafeSerializer
from starlette.websockets import WebSocket

from radiotelescope.services.queue import QueueService

logger = logging.getLogger(__name__)


def _serializer(request_or_ws: Request | WebSocket) -> URLSafeSerializer:
    cfg = request_or_ws.app.state.config.queue
    return URLSafeSerializer(cfg.cookie_secret, salt="rt_session")


def read_session_token(request: Request | WebSocket) -> str | None:
    cfg = request.app.state.config.queue
    raw = request.cookies.get(cfg.cookie_name)
    if not raw:
        return None
    try:
        return _serializer(request).loads(raw)
    except BadSignature:
        logger.warning("Rejected tampered session cookie")
        return None


def write_session_token(response, request: Request, token: str) -> None:
    cfg = request.app.state.config.queue
    server_cfg = request.app.state.config.server
    signed = _serializer(request).dumps(token)
    response.set_cookie(
        key=cfg.cookie_name,
        value=signed,
        max_age=60 * 60 * 24,  # 1 day
        httponly=True,
        secure=server_cfg.public_exposure or request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def is_lan_admin(request: Request | WebSocket) -> bool:
    """True if the real client IP is in the configured allowlist (admin override)."""
    allowed = set(request.app.state.config.server.allowed_clients)
    if not allowed:
        return False
    ip = client_ip(request)
    if ip is None:
        return False
    if ip in allowed:
        return True
    # Loopback always counts as admin.
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_loopback


def client_ip(request: Request | WebSocket) -> str | None:
    client = request.client
    peer = client.host if client else None
    cfg = request.app.state.config.server
    if not cfg.public_exposure or peer is None:
        return peer

    trusted = set(cfg.trusted_proxies)
    if peer not in trusted and not _is_loopback(peer):
        return peer

    forwarded_for = request.headers.get("x-forwarded-for")
    if not forwarded_for:
        # In public mode, a trusted proxy connection without X-Forwarded-For
        # should not inherit the proxy/loopback address as a LAN admin.
        return None
    return forwarded_for.split(",", 1)[0].strip() or None


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def queue_service(request: Request | WebSocket) -> QueueService:
    return request.app.state.queue_service


async def require_control(request: Request) -> None:
    """Gate control endpoints: must be the active queue holder.

    LAN admins are auto-joined by /api/queue/status, so they hold a real
    session token and flow through this same check — that way the idle/lease
    timers actually advance for local clients too.
    """
    if request.app.state.config.hardware.mode == "gateway-server" and is_lan_admin(request):
        return
    if not request.app.state.config.queue.enabled:
        return
    if is_lan_admin(request):
        return
    token = read_session_token(request)
    queue = queue_service(request)
    if not queue.is_active(token):
        raise HTTPException(
            status_code=403,
            detail="You are not the active controller. Join the queue and wait your turn.",
        )
    await queue.mark_command(token)


def lan_admin_or_session(request: Request) -> str | None:
    """Returns the session token, or None for LAN admin / disabled queue."""
    if is_lan_admin(request):
        return None
    return read_session_token(request)


async def require_lan_admin(request: Request) -> None:
    """Gate operator-only endpoints (calibration, homing) to local IPs.

    Stricter than require_control: even the active queue holder cannot hit
    these from the public side. Used for endpoints that mutate persistent
    state (encoder zeros, alt/az offsets) where a public-internet user
    shouldn't be allowed to drift the dish's reference frame.
    """
    if is_lan_admin(request):
        return
    raise HTTPException(status_code=404, detail="Not found")


def trusted_proxy_ips(allowed: Iterable[str]) -> str:
    return ",".join(allowed)
