"""Password-based auth: middleware, logout route, and brute-force protection."""

from __future__ import annotations

import hmac
import logging
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, URLSafeSerializer
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("radiotelescope.auth")

_COOKIE_NAME = "rt_auth"
_EXEMPT_PATHS = frozenset({
    "/api/auth/logout",
    # The SPA root and queue bootstrap/join must be reachable before the user
    # has an auth cookie so the inline password form can load and submit.
    "/",
    "/api/queue/config",
    "/api/queue/join",
})
_EXEMPT_PREFIXES = (
    "/assets/",
    # Admin endpoints enforce LAN-only access at the route level
    # (require_lan_admin → 404 for non-LAN clients). The beta-password
    # gate would block operators on the LAN who don't have a user cookie.
    "/api/admin/",
)
_EXEMPT_STATIC_SUFFIXES = (
    ".css",
    ".gif",
    ".ico",
    ".jpg",
    ".jpeg",
    ".js",
    ".png",
    ".svg",
    ".webp",
)
_MAX_IP_RECORDS = 10_000


@dataclass
class _IPRecord:
    attempts: int = 0
    locked_until: float = 0.0  # time.monotonic()


class AuthManager:
    """Holds passwords, brute-force state, and the cookie serializer."""

    def __init__(
        self,
        *,
        enabled: bool,
        secret: str,
        passwords_path: Path,
        max_attempts: int,
        lockout_seconds: int,
    ) -> None:
        self.enabled = enabled
        self.max_attempts = max_attempts
        self.lockout_seconds = lockout_seconds
        self._ser = URLSafeSerializer(secret, salt="rt_auth")
        self._passwords = _load_passwords(passwords_path) if enabled else set()
        self._records: dict[str, _IPRecord] = defaultdict(_IPRecord)

    # ── Cookie validation ────────────────────────────────────────────────────

    def is_valid_cookie(self, cookie_header: str) -> bool:
        prefix = _COOKIE_NAME + "="
        for part in cookie_header.split(";"):
            part = part.strip()
            if part.startswith(prefix):
                try:
                    self._ser.loads(part[len(prefix):])
                    return True
                except BadSignature:
                    logger.warning("Auth: rejected tampered cookie")
                    return False
        return False

    def make_cookie_value(self) -> str:
        return self._ser.dumps(secrets.token_hex(32))

    def set_auth_cookie(self, response: "Response", *, is_secure: bool) -> None:
        """Attach a signed auth cookie to a FastAPI Response."""
        response.set_cookie(
            key=_COOKIE_NAME,
            value=self.make_cookie_value(),
            max_age=30 * 24 * 60 * 60,  # 30 days
            httponly=True,
            secure=is_secure,
            samesite="lax",
            path="/",
        )

    # ── Password check ───────────────────────────────────────────────────────

    def check_password(self, password: str) -> bool:
        # Iterate every stored password without short-circuiting so the loop
        # duration doesn't reveal whether or how early a match was found.
        matched = False
        for p in self._passwords:
            if hmac.compare_digest(password, p):
                matched = True
        return matched

    # ── Brute-force tracking ─────────────────────────────────────────────────

    def is_locked(self, ip: str) -> bool:
        rec = self._records[ip]
        return rec.locked_until > 0 and time.monotonic() < rec.locked_until

    def _prune_records(self) -> None:
        if len(self._records) < _MAX_IP_RECORDS:
            return
        now = time.monotonic()
        expired = [k for k, v in self._records.items() if v.locked_until == 0 or now >= v.locked_until]
        for k in expired:
            del self._records[k]

    def record_failure(self, ip: str) -> bool:
        """Record a failed attempt. Returns True if the IP is now locked out."""
        self._prune_records()
        rec = self._records[ip]
        if rec.locked_until and time.monotonic() >= rec.locked_until:
            rec.attempts = 0
            rec.locked_until = 0.0
        rec.attempts += 1
        if rec.attempts >= self.max_attempts:
            rec.locked_until = time.monotonic() + self.lockout_seconds
            logger.warning(
                "Auth: IP %s locked out for %ds after %d failed attempts",
                ip,
                self.lockout_seconds,
                rec.attempts,
            )
            return True
        logger.warning(
            "Auth: failed login from %s (attempt %d/%d)",
            ip,
            rec.attempts,
            self.max_attempts,
        )
        return False

    def record_success(self, ip: str) -> None:
        if ip in self._records:
            self._records[ip].attempts = 0
            self._records[ip].locked_until = 0.0

    # ── Auth event logging ───────────────────────────────────────────────────

    def log_attempt(
        self,
        *,
        ip_hash: str | None,
        result: str,
        password: str | None,
        session_id: str | None,
        log_path: "Path",
        max_bytes: int,
    ) -> None:
        """Write one auth event to JSONL and push to Loki (fire-and-forget)."""
        from rt_platform.api.log_files import append_jsonl_with_rotation, utc_now_iso
        from rt_platform import loki

        entry: dict = {
            "ts": utc_now_iso(),
            "result": result,
            "ip_hash": ip_hash,
            "session_id": session_id,
        }
        # Include the password only while auth is enabled — if auth is later
        # disabled the call sites guard on auth.enabled and never reach here,
        # but this provides belt-and-suspenders suppression just in case.
        if self.enabled and password is not None:
            entry["password"] = password

        try:
            append_jsonl_with_rotation(log_path, entry, max_bytes)
        except Exception as exc:
            logger.warning("Auth: failed to write auth_events.jsonl: %s", exc)

        loki.push("rt_auth", entry)


def _load_passwords(path: Path) -> set[str]:
    if not path.exists():
        logger.warning("Auth: passwords file not found: %s — all logins will fail", path)
        return set()
    passwords = set()
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            passwords.add(stripped)
    logger.info("Auth: loaded %d password(s) from %s", len(passwords), path)
    return passwords


# ── ASGI middleware ──────────────────────────────────────────────────────────

class PasswordAuthMiddleware:
    def __init__(self, app: ASGIApp, *, auth: AuthManager) -> None:
        self.app = app
        self.auth = auth

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.auth.enabled or scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if (
            path in _EXEMPT_PATHS
            or any(path.startswith(p) for p in _EXEMPT_PREFIXES)
            or (scope["type"] == "http" and path.lower().endswith(_EXEMPT_STATIC_SUFFIXES))
        ):
            await self.app(scope, receive, send)
            return

        headers = {k: v for k, v in scope.get("headers", [])}
        cookie_header = headers.get(b"cookie", b"").decode("latin-1")

        if self.auth.is_valid_cookie(cookie_header):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": "Authentication required"})
            return

        accept = headers.get(b"accept", b"").decode("latin-1")
        if "text/html" in accept:
            await _redirect(send, b"/")
        else:
            body = b'{"detail":"Authentication required"}'
            await _http_response(send, 401, b"application/json", body)


async def _redirect(send: Send, location: bytes) -> None:
    await send({
        "type": "http.response.start",
        "status": 302,
        "headers": [(b"location", location), (b"content-length", b"0")],
    })
    await send({"type": "http.response.body", "body": b""})


async def _http_response(send: Send, status: int, content_type: bytes, body: bytes) -> None:
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"content-type", content_type),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})


# ── Routes ───────────────────────────────────────────────────────────────────

router = APIRouter()


@router.post("/api/auth/logout", include_in_schema=False)
async def do_logout() -> RedirectResponse:
    resp = RedirectResponse(url="/", status_code=303)
    resp.delete_cookie(_COOKIE_NAME, path="/")
    return resp
