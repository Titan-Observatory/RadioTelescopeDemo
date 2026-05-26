from __future__ import annotations

import base64
import hashlib
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from rt_platform.api import (
    routes_camera,
    routes_events,
    routes_feedback,
    routes_motor,
    routes_queue,
    routes_spectrum,
)
from rt_platform.api.auth import AuthManager, PasswordAuthMiddleware
from rt_platform.api.auth import router as auth_router
from rt_platform.api.client_allowlist import ClientAllowlistMiddleware
from rt_platform.api.rate_limit import RateLimitMiddleware
from rt_platform.api.security_headers import SecurityHeadersMiddleware
from rt_platform.config import load_config, public_exposure_errors
from rt_platform.loki import configure as configure_loki
from rt_platform.services.hardware_client import HardwareClient
from rt_platform.services.queue import QueueService
from rt_platform.services.spectrum_bridge import SpectrumBridge

logger = logging.getLogger("rt_platform")

ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
PUBLIC_FILE_CACHE_CONTROL = "public, max-age=2592000"
INDEX_CACHE_CONTROL = "no-cache"
RT_ENV_CACHE_CONTROL = "no-cache"


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config

    queue = QueueService(
        max_session_seconds=cfg.queue.max_session_seconds,
        idle_timeout_seconds=cfg.queue.idle_timeout_seconds,
        max_queue_size=cfg.queue.max_queue_size,
        max_sessions_per_ip=cfg.queue.max_sessions_per_ip,
        join_cooldown_seconds=cfg.queue.join_cooldown_seconds,
    )
    app.state.queue_service = queue

    hardware = HardwareClient(cfg.hardware_url)
    app.state.hardware_client = hardware

    ws_base = _http_to_ws(cfg.hardware_url)
    bridge = SpectrumBridge(ws_base)
    app.state.spectrum_bridge = bridge

    await hardware.start()
    await queue.start()
    await bridge.start()

    logger.info("rt-platform started (hardware_url=%s)", cfg.hardware_url)
    yield

    await bridge.stop()
    await queue.stop()
    await hardware.stop()
    logger.info("rt-platform shut down")


def _http_to_ws(url: str) -> str:
    if url.startswith("http://"):
        return "ws://" + url[len("http://"):]
    if url.startswith("https://"):
        return "wss://" + url[len("https://"):]
    return url


def create_app(config_path: str | Path = "config.toml") -> FastAPI:
    cfg = load_config(config_path)
    exposure_errors = public_exposure_errors(cfg)
    if exposure_errors:
        details = "; ".join(exposure_errors)
        raise RuntimeError(f"Unsafe public exposure configuration: {details}")

    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    configure_loki(cfg.loki_url)

    app = FastAPI(title="RT Platform", lifespan=lifespan)
    app.state.config = cfg

    auth = AuthManager(
        enabled=cfg.auth.enabled,
        secret=cfg.auth.secret_key,
        passwords_path=Path(cfg.auth.passwords_file),
        max_attempts=cfg.auth.max_attempts,
        lockout_seconds=cfg.auth.lockout_minutes * 60,
    )
    app.state.auth = auth

    # Compute the inline gtag snippet and its CSP hash before adding middleware so
    # the hash can be included in script-src.  The snippet is the standard Google
    # tag (async loader + dataLayer init + config call) injected into index.html;
    # the hash lets the browser run it despite having no 'unsafe-inline' in CSP.
    _gtag_inline_hash: str | None = None
    if cfg.gtag_id:
        _gtag_inline_hash = _gtag_csp_hash(cfg.gtag_id, cfg.gtag_debug)

    app.add_middleware(SecurityHeadersMiddleware, gtag_inline_hash=_gtag_inline_hash)
    app.add_middleware(RateLimitMiddleware, config=cfg.rate_limit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.server.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(
        ClientAllowlistMiddleware,
        allowed_clients=cfg.server.allowed_clients,
        block_unknown=cfg.server.lan_only,
    )
    app.add_middleware(PasswordAuthMiddleware, auth=auth)

    app.include_router(auth_router)
    app.include_router(routes_motor.router)
    app.include_router(routes_queue.router)
    app.include_router(routes_camera.router)
    app.include_router(routes_spectrum.router)
    app.include_router(routes_feedback.router)
    app.include_router(routes_events.router)

    @app.get("/rt-env.js", include_in_schema=False)
    async def serve_rt_env_js(request: Request):
        cfg = request.app.state.config
        public_config = (
            {"gtagId": cfg.gtag_id, "gtagDebug": cfg.gtag_debug}
            if cfg.gtag_id
            else {}
        )
        body = (
            f"window.RT_PUBLIC_CONFIG = {json.dumps(public_config)};\n"
            "window.dispatchEvent(new Event('rt-public-config-ready'));\n"
        )
        return Response(
            content=body,
            media_type="application/javascript",
            headers={"Cache-Control": RT_ENV_CACHE_CONTROL},
        )

    frontend_dist = _find_frontend_dist()
    if frontend_dist.exists():
        app.mount("/assets", CachedStaticFiles(directory=frontend_dist / "assets"), name="assets")

        # Pre-compute index.html bytes with the gtag async script tag injected so
        # that (a) Google's tag-detection crawler finds it in the static HTML and
        # (b) the browser starts fetching gtag.js during HTML parsing rather than
        # waiting for the JS bundle to run.  The tag is just the external <script>
        # element; the dataLayer/gtag() init and gtag('config') call stay in
        # analytics.ts (served from 'self', so no CSP changes needed).
        _index_bytes = _build_index_bytes(frontend_dist / "index.html", cfg.gtag_id, cfg.gtag_debug)

        @app.get("/")
        async def serve_index():
            return _index_response(_index_bytes, frontend_dist / "index.html")

        _frontend_root = frontend_dist.resolve()

        @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        async def serve_spa(path: str, request: Request):
            if path.startswith("api/"):
                return PlainTextResponse("Not found", status_code=404)
            if path.startswith("ws/"):
                return PlainTextResponse("Not found", status_code=404)
            if request.method != "GET":
                return PlainTextResponse("Method not allowed", status_code=405)
            return await _serve_spa_file(path, frontend_dist, _frontend_root)

        async def _serve_spa_file(path: str, frontend_dist: Path, frontend_root: Path):
            target = (frontend_dist / path).resolve()
            if not target.is_relative_to(frontend_root):
                return _index_response(_index_bytes, frontend_dist / "index.html")
            if target.is_file():
                return _file_response(target, _cache_control_for_spa_file(target, frontend_root))
            return _index_response(_index_bytes, frontend_dist / "index.html")
    else:
        logger.warning("Frontend build not found; run `npm run build` in platform/frontend/")

        @app.get("/")
        async def missing_frontend():
            return PlainTextResponse(
                "rt-platform backend is running, but the web UI has not been built. "
                "Run `cd platform/frontend && npm run build`, then restart. "
                "For development, use the Vite UI at http://<host>:5173/.",
                status_code=503,
            )

    return app


def _find_frontend_dist() -> Path:
    candidates = [
        Path.cwd() / "platform" / "frontend" / "dist",
        Path.cwd() / "frontend" / "dist",
        Path(__file__).resolve().parents[3] / "frontend" / "dist",
        Path(__file__).resolve().parent / "frontend" / "dist",
    ]
    for candidate in candidates:
        if (candidate / "index.html").exists():
            return candidate
    return candidates[0]


def _gtag_inline_script(gtag_id: str, debug: bool) -> str:
    """Return the compact inline gtag initialization script (no trailing newline)."""
    config_opts = ",{debug_mode:true}" if debug else ""
    return (
        f"window.dataLayer=window.dataLayer||[];"
        f"function gtag(){{dataLayer.push(arguments);}}"
        f"gtag('js',new Date());"
        f"gtag('config','{gtag_id}'{config_opts});"
        # Signal to analytics.ts that config has already been sent so it won't
        # call gtag('config', ...) a second time and double-count page_views.
        f"window._gtagReady=true;"
    )


def _gtag_csp_hash(gtag_id: str, debug: bool) -> str:
    """Return the 'sha256-...' CSP hash for the inline gtag script."""
    content = _gtag_inline_script(gtag_id, debug).encode("utf-8")
    digest = hashlib.sha256(content).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


def _build_index_bytes(index_path: Path, gtag_id: str, debug: bool = False) -> bytes | None:
    """Read index.html and inject the full standard gtag snippet, or return None."""
    if not index_path.exists() or not gtag_id:
        return None
    html = index_path.read_text(encoding="utf-8")
    inline = _gtag_inline_script(gtag_id, debug)
    # Full standard Google tag: async loader + inline init block.
    # Both are allowed by CSP: the loader via the googletagmanager.com host rule,
    # the inline block via the sha256 hash added to script-src at startup.
    snippet = (
        f'<script async src="https://www.googletagmanager.com/gtag/js?id={gtag_id}"></script>'
        f"<script>{inline}</script>"
    )
    marker = "<head>"
    idx = html.find(marker)
    if idx == -1:
        return html.encode()
    insert_at = idx + len(marker)
    injected = html[:insert_at] + "\n    " + snippet + html[insert_at:]
    return injected.encode()


def _index_response(prebuilt: bytes | None, fallback_path: Path) -> Response | FileResponse:
    """Return a Response using pre-injected bytes, or fall back to a plain FileResponse."""
    if prebuilt is not None:
        return Response(
            content=prebuilt,
            media_type="text/html",
            headers={"Cache-Control": INDEX_CACHE_CONTROL},
        )
    return _file_response(fallback_path, INDEX_CACHE_CONTROL)


def _file_response(path: Path, cache_control: str) -> FileResponse:
    return FileResponse(path, headers={"Cache-Control": cache_control})


def _cache_control_for_spa_file(path: Path, frontend_root: Path) -> str:
    try:
        path.relative_to(frontend_root / "assets")
    except ValueError:
        pass
    else:
        return ASSET_CACHE_CONTROL

    if path.name == "index.html":
        return INDEX_CACHE_CONTROL
    return PUBLIC_FILE_CACHE_CONTROL


class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", ASSET_CACHE_CONTROL)
        return response


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="RT Platform Service")
    parser.add_argument("-c", "--config", default="config.toml", help="Path to config.toml")
    args = parser.parse_args()

    app = create_app(args.config)
    cfg = app.state.config
    try:
        uvicorn.run(
            app,
            host=cfg.server.host,
            port=cfg.server.port,
            proxy_headers=True,
            forwarded_allow_ips=",".join(cfg.server.trusted_proxies),
            timeout_graceful_shutdown=3,
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
