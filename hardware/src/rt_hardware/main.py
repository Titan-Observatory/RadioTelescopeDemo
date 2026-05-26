from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse

from rt_hardware.api import routes_camera, routes_roboclaw, routes_spectrum
from rt_hardware.api.routes_roboclaw import ElevationHomingError, perform_elevation_homing
from rt_hardware.config import load_config
from rt_hardware.hardware.roboclaw import make_client
from rt_hardware.models.state import ElevationHomeRequest
from rt_hardware.pointing import compute_fwhm_deg, make_antenna
from rt_hardware.services.camera import CameraService
from rt_hardware.services.roboclaw import RoboClawService
from rt_hardware.services.spectrum import SpectrumService

logger = logging.getLogger("rt_hardware")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = app.state.config

    client = make_client(cfg.roboclaw)

    antenna = make_antenna(cfg.observer)
    app.state.antenna = antenna
    app.state.fwhm_deg = compute_fwhm_deg(cfg.observer)

    service = RoboClawService(client, cfg.telemetry.update_rate_hz, cfg.mount, antenna)
    app.state.roboclaw_service = service

    spectrum: SpectrumService | None = None
    if cfg.sdr.enabled:
        spectrum = SpectrumService(cfg.sdr, app.state.config_path)
        app.state.spectrum_service = spectrum

    camera: CameraService | None = None
    if cfg.camera.enabled:
        camera = CameraService(cfg.camera.device, cfg.camera.width, cfg.camera.height)
        app.state.camera_service = camera

    await service.start()
    if spectrum is not None:
        # Apply LNA bias-tee during lifespan startup, before the app accepts
        # requests. The GR subprocess is spawned lazily on the first
        # /ws/spectrum subscriber, so at this point nothing holds the Airspy
        # and airspy_gpio has exclusive USB access. Once a subscriber arrives
        # and the subprocess opens Soapy, it owns the device and airspy_gpio
        # would fail — so this must happen here, not later.
        if cfg.sdr.lna_bias_tee_enabled:
            try:
                status = await spectrum.apply_configured_bias_tee()
                logger.info("LNA bias tee enabled at boot: %s", status.detail)
            except Exception as exc:
                logger.warning("LNA bias tee could not be applied at boot: %s", exc)
        else:
            logger.info("LNA bias tee disabled (config); not touching hardware")
        await spectrum.start()

    logger.info("rt-hardware started (hardware=%s)", client.connection.mode)

    if cfg.mount.home_elevation_on_boot:
        if client.connection.mode == "disconnected":
            logger.info("Skipping boot elevation homing: hardware disconnected")
        else:
            speed = ElevationHomeRequest().speed
            logger.info("Boot sequence: homing elevation axis at speed %d", speed)
            try:
                message = await perform_elevation_homing(service, speed)
                logger.info("Boot homing complete: %s", message)
            except ElevationHomingError as exc:
                logger.warning("Boot elevation homing failed: %s", exc)
            except Exception:
                logger.exception("Boot elevation homing raised an unexpected error")

    yield

    if spectrum is not None:
        await spectrum.stop()
    if camera is not None:
        await camera.stop()
    await service.stop()
    logger.info("rt-hardware shut down")


def create_app(config_path: str | Path = "config.toml") -> FastAPI:
    cfg = load_config(config_path)
    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    app = FastAPI(title="RT Hardware", lifespan=lifespan)
    app.state.config = cfg
    # The SpectrumService re-loads this path inside the GNU Radio subprocess
    # so its view of the SDR config matches ours exactly.
    app.state.config_path = str(Path(config_path).resolve())

    app.include_router(routes_roboclaw.router)
    app.include_router(routes_spectrum.router)
    if cfg.camera.enabled:
        app.include_router(routes_camera.router)

    @app.get("/")
    async def index():
        return PlainTextResponse(
            "rt-hardware: motors + SDR + camera. See /docs or /openapi.json.",
        )

    return app


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="RT Hardware Service")
    parser.add_argument("-c", "--config", default="config.toml", help="Path to config.toml")
    args = parser.parse_args()

    app = create_app(args.config)
    cfg = app.state.config
    try:
        uvicorn.run(
            app,
            host=cfg.server.host,
            port=cfg.server.port,
            timeout_graceful_shutdown=3,
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
