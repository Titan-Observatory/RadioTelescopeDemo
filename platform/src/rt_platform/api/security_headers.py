"""ASGI middleware that injects security headers on every HTTP response."""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

# CSP notes:
#   script-src — Turnstile loader from Cloudflare; wasm-unsafe-eval for Aladin;
#     googletagmanager.com for Google Analytics (dynamically injected by analytics.ts)
#   style-src https: + unsafe-inline — third-party widget styles + inline styles
#   img-src https: data: blob: — Aladin sky map tiles + data URIs
#   connect-src https: + ws/wss + data: — telemetry sockets, CDS HiPS services,
#     Turnstile verify, Aladin's data:-URL wasm fetch, GA telemetry
#   frame-src — Turnstile widget iframe
#   frame-ancestors 'none' — disallow being embedded (clickjacking); also
#     supersedes X-Frame-Options on all modern browsers
def _build_headers(gtag_inline_hash: str | None = None) -> list[tuple[bytes, bytes]]:
    """Build the security header list, optionally allowing an inline gtag script by hash."""
    script_src = (
        b"'self' 'wasm-unsafe-eval' "
        b"https://challenges.cloudflare.com "
        b"https://www.googletagmanager.com "
        b"https://googleads.g.doubleclick.net"
    )
    if gtag_inline_hash:
        # Allow the specific inline gtag init snippet injected into index.html.
        # A hash is safe: only that exact script content is permitted, nothing else.
        script_src += b" " + gtag_inline_hash.encode()
    return [
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"DENY"),
        (b"referrer-policy", b"strict-origin-when-cross-origin"),
        (
            b"content-security-policy",
            b"default-src 'self'; "
            b"script-src " + script_src + b"; "
            b"style-src 'self' 'unsafe-inline' https:; "
            b"img-src 'self' data: blob: https:; "
            b"font-src 'self' data: https:; "
            b"connect-src 'self' ws: wss: data: https:; "
            b"worker-src 'self' blob:; "
            b"frame-src https://challenges.cloudflare.com; "
            b"frame-ancestors 'none'; "
            b"form-action 'self'",
        ),
    ]


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, *, gtag_inline_hash: str | None = None) -> None:
        self.app = app
        self._headers = _build_headers(gtag_inline_hash)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = list(message.get("headers", []))
                message = {**message, "headers": existing + self._headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
