"""Password-based auth: middleware, login/logout routes, and brute-force protection."""

from __future__ import annotations

import hmac
import html
import logging
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Form, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeSerializer
from starlette.types import ASGIApp, Receive, Scope, Send

from radiotelescope.api.dependencies import client_ip

logger = logging.getLogger("radiotelescope.auth")

_COOKIE_NAME = "rt_auth"
_EXEMPT_PATHS = frozenset({
    "/login",
    "/api/auth/login",
    "/api/auth/logout",
    # The SPA root and queue bootstrap/join must be reachable before the user
    # has an auth cookie so the inline password form can load and submit.
    "/",
    "/api/queue/config",
    "/api/queue/join",
})
_EXEMPT_PREFIXES = ("/assets/",)
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
        if path in _EXEMPT_PATHS or any(path.startswith(p) for p in _EXEMPT_PREFIXES):
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
            await _redirect(send, b"/login")
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


# ── Login page HTML ──────────────────────────────────────────────────────────

_LOGIN_PAGE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Radio Telescope — Sign In</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0b0f1a;
    font-family: system-ui, -apple-system, sans-serif;
    color: #c9cfe8;
  }
  .card {
    background: #131929;
    border: 1px solid #2a3050;
    border-radius: 10px;
    padding: 2.25rem 2rem;
    width: 100%;
    max-width: 360px;
    box-shadow: 0 8px 32px rgba(0,0,0,.5);
  }
  h1 {
    font-size: 1.2rem;
    font-weight: 600;
    color: #e8ecff;
    margin-bottom: 1.75rem;
    text-align: center;
    letter-spacing: .02em;
  }
  label {
    display: block;
    font-size: 0.8125rem;
    color: #8b91b0;
    margin-bottom: 0.4rem;
    text-transform: uppercase;
    letter-spacing: .06em;
  }
  input[type="password"] {
    width: 100%;
    padding: 0.55rem 0.75rem;
    background: #0b0f1a;
    border: 1px solid #2a3050;
    border-radius: 6px;
    color: #e8ecff;
    font-size: 1rem;
    outline: none;
    margin-bottom: 1.1rem;
    transition: border-color .15s;
  }
  input[type="password"]:focus {
    border-color: #c9a84c;
    box-shadow: 0 0 0 3px rgba(201,168,76,.12);
  }
  button {
    width: 100%;
    padding: 0.6rem;
    background: #c9a84c;
    color: #0b0f1a;
    border: none;
    border-radius: 6px;
    font-size: 0.9375rem;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: .03em;
    transition: background .15s;
  }
  button:hover { background: #dfc06a; }
  .error {
    color: #f87171;
    font-size: 0.8125rem;
    margin-bottom: 0.9rem;
    padding: 0.5rem 0.625rem;
    background: rgba(248,113,113,.08);
    border-radius: 5px;
    border: 1px solid rgba(248,113,113,.25);
  }
</style>
</head>
<body>
<div class="card">
  <h1>Radio Telescope</h1>
  <form method="post" action="/api/auth/login">
    <label for="pw">Beta Access Password</label>
    <input type="password" id="pw" name="password" autofocus required autocomplete="current-password">
    ERROR_PLACEHOLDER
    <button type="submit">Sign In</button>
  </form>
</div>
</body>
</html>"""


def _login_html(error: str = "") -> str:
    block = f'<p class="error">{html.escape(error)}</p>' if error else ""
    return _LOGIN_PAGE.replace("ERROR_PLACEHOLDER", block)


# ── Routes ───────────────────────────────────────────────────────────────────

router = APIRouter()


@router.get("/login", include_in_schema=False, response_model=None)
async def login_page(request: Request) -> HTMLResponse | RedirectResponse:
    auth: AuthManager = request.app.state.auth
    if not auth.enabled:
        return RedirectResponse("/")
    return HTMLResponse(_login_html())


@router.post("/api/auth/login", include_in_schema=False, response_model=None)
async def do_login(request: Request, password: str = Form(...)) -> HTMLResponse | RedirectResponse:
    auth: AuthManager = request.app.state.auth
    ip = client_ip(request) or "unknown"

    if auth.is_locked(ip):
        logger.warning("Auth: blocked request from locked IP %s", ip)
        return HTMLResponse(
            _login_html("Too many failed attempts. Try again later."),
            status_code=429,
        )

    if auth.check_password(password):
        auth.record_success(ip)
        logger.info("Auth: successful login from %s", ip)
        resp = RedirectResponse(url="/", status_code=303)
        server_cfg = request.app.state.config.server
        resp.set_cookie(
            key=_COOKIE_NAME,
            value=auth.make_cookie_value(),
            max_age=30 * 24 * 60 * 60,  # 30 days
            httponly=True,
            secure=server_cfg.public_exposure or request.url.scheme == "https",
            samesite="lax",
            path="/",
        )
        return resp

    locked = auth.record_failure(ip)
    if locked:
        msg = f"Too many failed attempts. Try again in {auth.lockout_seconds // 60} minutes."
    else:
        msg = "Incorrect password."
    return HTMLResponse(_login_html(msg), status_code=401)


@router.post("/api/auth/logout", include_in_schema=False)
async def do_logout() -> RedirectResponse:
    resp = RedirectResponse(url="/login", status_code=303)
    resp.delete_cookie(_COOKIE_NAME, path="/")
    return resp
