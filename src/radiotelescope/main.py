from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from radiotelescope.api import (
    routes_camera,
    routes_camera_proxy,
    routes_events,
    routes_feedback,
    routes_queue,
    routes_roboclaw,
    routes_spectrum,
    routes_spectrum_proxy,
)
from radiotelescope.api.auth import AuthManager, PasswordAuthMiddleware
from radiotelescope.api.auth import router as auth_router
from radiotelescope.api.client_allowlist import ClientAllowlistMiddleware
from radiotelescope.api.rate_limit import RateLimitMiddleware
from radiotelescope.api.security_headers import SecurityHeadersMiddleware
from radiotelescope.config import load_config, public_exposure_errors
from radiotelescope.hardware.remote import RemoteRoboClawClient
from radiotelescope.hardware.roboclaw import make_client
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.pointing import compute_fwhm_deg, make_antenna
from radiotelescope.services.queue import QueueService
from radiotelescope.services.roboclaw import RoboClawService
from radiotelescope.services.spectrum import SpectrumService
from radiotelescope.services.spectrum_bridge import SpectrumBridge

logger = logging.getLogger("radiotelescope")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config
    mode = cfg.hardware.mode

    # ── Hardware clients: local serial/USB vs HTTP/WS to a remote gateway ──
    if mode == "gateway-client":
        client = RemoteRoboClawClient(cfg.hardware)
        logger.info("RoboClaw running in gateway-client mode against %s", cfg.hardware.base_url)
    else:
        client = make_client(cfg.roboclaw)

    antenna = make_antenna(cfg.observer)
    app.state.antenna = antenna
    app.state.fwhm_deg = compute_fwhm_deg(cfg.observer)
    service = RoboClawService(client, cfg.telemetry.update_rate_hz, cfg.mount, antenna)
    app.state.roboclaw_service = service

    queue = QueueService(
        max_session_seconds=cfg.queue.max_session_seconds,
        idle_timeout_seconds=cfg.queue.idle_timeout_seconds,
        max_queue_size=cfg.queue.max_queue_size,
        max_sessions_per_ip=cfg.queue.max_sessions_per_ip,
        join_cooldown_seconds=cfg.queue.join_cooldown_seconds,
    )
    app.state.queue_service = queue

    # ── SDR pipeline: FFT runs next to the SDR; the LAN host only relays ──
    #
    # ``local`` and ``gateway-server`` both instantiate the real
    # ``SpectrumService`` because the Airspy is physically attached.
    # ``gateway-client`` instead runs a thin ``SpectrumBridge`` that
    # subscribes once to the Pi's ``/ws/spectrum`` and fans frames out to
    # local browsers — shipping integrated spectra (~1.3 Mbps) instead of
    # raw IQ (~192 Mbps), which the Pi 3B+'s 100 Mbps NIC cannot carry.
    spectrum: SpectrumService | None = None
    bridge: SpectrumBridge | None = None
    if cfg.sdr.enabled:
        if mode == "gateway-client":
            bridge = SpectrumBridge(cfg.hardware)
            app.state.spectrum_bridge = bridge
        else:
            spectrum = SpectrumService(SDRReceiver(cfg.sdr), cfg.sdr)
            app.state.spectrum_service = spectrum

    await service.start()
    await queue.start()
    if spectrum is not None:
        await spectrum.start()
    if bridge is not None:
        await bridge.start()

    logger.info("RoboClaw controller started in %s mode (hardware=%s)", client.connection.mode, mode)
    yield

    if bridge is not None:
        await bridge.stop()
    if spectrum is not None:
        await spectrum.stop()
    await queue.stop()
    await service.stop()
    logger.info("RoboClaw controller shut down")


def create_app(config_path: str | Path = "config.toml") -> FastAPI:
    cfg = load_config(config_path)
    exposure_errors = public_exposure_errors(cfg)
    if exposure_errors:
        details = "; ".join(exposure_errors)
        raise RuntimeError(f"Unsafe public exposure configuration: {details}")
    mode = cfg.hardware.mode

    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    app = FastAPI(title="RoboClaw Controller", lifespan=lifespan)
    app.state.config = cfg

    auth = AuthManager(
        enabled=cfg.auth.enabled,
        secret=cfg.auth.secret_key,
        passwords_path=Path(cfg.auth.passwords_file),
        max_attempts=cfg.auth.max_attempts,
        lockout_seconds=cfg.auth.lockout_minutes * 60,
    )
    app.state.auth = auth

    app.add_middleware(SecurityHeadersMiddleware)
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

    # Motor + queue routes are needed in every mode — gateway-server uses
    # them to accept commands from the host; gateway-client uses them to
    # serve the dashboard.
    app.include_router(routes_roboclaw.router)
    app.include_router(routes_queue.router)

    if mode == "gateway-client":
        # Camera lives on the Pi; proxy through.
        app.include_router(routes_camera_proxy.router)
    else:
        app.include_router(routes_camera.router)

    # Spectrum endpoints live wherever the FFT is computed. ``local`` and
    # ``gateway-server`` both serve them directly; ``gateway-client`` mounts
    # a proxy that forwards HTTP to the Pi and bridges ``/ws/spectrum``
    # through the in-process ``SpectrumBridge`` pubsub.
    if mode == "gateway-client":
        app.include_router(routes_spectrum_proxy.router)
    else:
        app.include_router(routes_spectrum.router)

    # Feedback + events are user-facing only; the gateway-server is headless.
    if mode != "gateway-server":
        app.include_router(routes_feedback.router)
        app.include_router(routes_events.router)

    if mode == "gateway-server":
        # Pi is headless in this mode — return a status line on `/` instead
        # of trying to find a built frontend.
        @app.get("/")
        async def gateway_index():
            return PlainTextResponse(
                "radiotelescope gateway-server: motors + SDR + camera are "
                "exposed here. Point a gateway-client host at this address.",
            )
        return app

    frontend_dist = _find_frontend_dist()
    if frontend_dist.exists():
        app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

        @app.get("/")
        async def serve_index():
            return FileResponse(frontend_dist / "index.html")

        _frontend_root = frontend_dist.resolve()

        @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        async def serve_spa(path: str, request: Request):
            if path.startswith("api/"):
                return PlainTextResponse("Not found", status_code=404)
            if path.startswith("ws/"):
                return PlainTextResponse("Not found", status_code=404)
            # The SPA fallback is only for browser navigation. Other methods
            # should fail plainly instead of being reported as GET-only routes.
            # This keeps missing API POSTs from looking like frontend route hits.
            if request.method != "GET":
                return PlainTextResponse("Method not allowed", status_code=405)
            return await _serve_spa_file(path, frontend_dist, _frontend_root)

        async def _serve_spa_file(path: str, frontend_dist: Path, frontend_root: Path):
            target = (frontend_dist / path).resolve()
            if not target.is_relative_to(frontend_root):
                return FileResponse(frontend_dist / "index.html")
            if target.is_file():
                return FileResponse(target)
            return FileResponse(frontend_dist / "index.html")
    else:
        logger.warning("Frontend build not found; run `npm run build` in frontend/ before using port 8000 for the UI")

        @app.get("/")
        async def missing_frontend():
            return PlainTextResponse(
                "RoboClaw backend is running, but the web UI has not been built. "
                "Run `cd frontend && npm run build`, then restart the backend. "
                "For development, use the Vite UI at http://<host>:5173/.",
                status_code=503,
            )

    return app


def _find_frontend_dist() -> Path:
    candidates = [
        Path.cwd() / "frontend" / "dist",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
        Path(__file__).resolve().parent / "frontend" / "dist",
    ]
    for candidate in candidates:
        if (candidate / "index.html").exists():
            return candidate
    return candidates[0]


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="RoboClaw Controller")
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
        # On Windows, uvicorn re-raises the captured SIGINT after a clean
        # shutdown, which surfaces as a noisy KeyboardInterrupt + CancelledError
        # traceback from asyncio.runners. Server is already stopped at this
        # point; swallow it so the exit looks clean.
        pass


if __name__ == "__main__":
    cli()
