from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from rt_platform.api.dependencies import (
    client_ip,
    queue_service,
    read_session_token,
    write_session_token,
)
from rt_platform.services.queue import QueueFullError, QueueRateLimitedError, QueueStatus

logger = logging.getLogger(__name__)
router = APIRouter(tags=["queue"])

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


class JoinRequest(BaseModel):
    turnstile_token: str | None = None
    beta_password: str | None = None


class QueueConfigResponse(BaseModel):
    enabled: bool
    turnstile_site_key: str
    turnstile_enabled: bool
    max_session_seconds: int
    idle_timeout_seconds: int
    beta_password_enabled: bool


@router.get("/api/queue/config", response_model=QueueConfigResponse)
async def queue_config(request: Request) -> QueueConfigResponse:
    cfg = request.app.state.config
    turnstile_required = (
        cfg.turnstile.enabled
        and bool(cfg.turnstile.site_key)
        and bool(cfg.turnstile.secret_key)
    )
    return QueueConfigResponse(
        enabled=cfg.queue.enabled,
        turnstile_enabled=turnstile_required,
        turnstile_site_key=cfg.turnstile.site_key,
        max_session_seconds=cfg.queue.max_session_seconds,
        idle_timeout_seconds=cfg.queue.idle_timeout_seconds,
        beta_password_enabled=cfg.auth.enabled,
    )


@router.get("/api/queue/status", response_model=QueueStatus)
async def queue_status(request: Request) -> QueueStatus:
    token = read_session_token(request)
    return queue_service(request).status_for(token)


@router.post("/api/queue/join", response_model=QueueStatus)
async def queue_join(body: JoinRequest, request: Request, response: Response) -> QueueStatus:
    cfg = request.app.state.config
    queue = queue_service(request)
    auth = request.app.state.auth
    ip = client_ip(request) or "unknown"

    if cfg.turnstile.enabled and cfg.turnstile.secret_key:
        if not body.turnstile_token:
            raise HTTPException(400, "Captcha token missing")
        if not await _verify_turnstile(
            secret=cfg.turnstile.secret_key,
            token=body.turnstile_token,
            remote_ip=client_ip(request),
        ):
            raise HTTPException(403, "Captcha verification failed")

    if auth.enabled:
        if auth.is_locked(ip):
            raise HTTPException(429, "Too many failed attempts. Try again later.")
        if not body.beta_password:
            raise HTTPException(400, "Beta access password required")
        if not auth.check_password(body.beta_password):
            locked = auth.record_failure(ip)
            if locked:
                raise HTTPException(
                    429,
                    f"Too many failed attempts. Try again in {auth.lockout_seconds // 60} minutes.",
                )
            raise HTTPException(403, "Incorrect password")
        auth.record_success(ip)
        is_secure = cfg.server.public_exposure or request.url.scheme == "https"
        auth.set_auth_cookie(response, is_secure=is_secure)

    existing = read_session_token(request)
    if existing is not None and await queue.rejoin(existing, client_ip(request) or ""):
        return queue.status_for(existing)

    try:
        token = await queue.join(ip)
    except QueueRateLimitedError as exc:
        raise HTTPException(429, str(exc)) from exc
    except QueueFullError as exc:
        raise HTTPException(503, str(exc)) from exc

    write_session_token(response, request, token)
    return queue.status_for(token)


@router.post("/api/queue/leave")
async def queue_leave(request: Request, response: Response) -> dict[str, str]:
    cfg = request.app.state.config.queue
    token = read_session_token(request)
    if token is not None:
        await queue_service(request).leave(token)
    response.delete_cookie(cfg.cookie_name, path="/")
    return {"status": "ok"}


@router.websocket("/ws/queue")
async def queue_ws(ws: WebSocket) -> None:
    await ws.accept()
    queue = queue_service(ws)

    token = read_session_token(ws)
    if token is None:
        await ws.send_json({"error": "not_in_queue"})
        await ws.close(code=1008)
        return

    await queue.mark_ws_connected(token, True)
    listener = queue.subscribe()

    async def _send_loop() -> None:
        await ws.send_json(queue.status_for(token).model_dump())
        while True:
            try:
                await asyncio.wait_for(listener.get(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            await ws.send_json(queue.status_for(token).model_dump())

    async def _recv_loop() -> None:
        # Any inbound message is treated as a UI-activity heartbeat; the
        # frontend throttles clicks / scrolls / keypresses into these pings
        # so the idle countdown isn't tied solely to control commands.
        while True:
            await ws.receive_text()
            await queue.mark_command(token)

    tasks: set[asyncio.Task[None]] = set()
    try:
        tasks = {
            asyncio.create_task(_send_loop(), name="queue-ws-send"),
            asyncio.create_task(_recv_loop(), name="queue-ws-recv"),
        }
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

        for task in done:
            try:
                task.result()
            except (WebSocketDisconnect, asyncio.CancelledError):
                pass
    except (WebSocketDisconnect, asyncio.CancelledError):
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        queue.unsubscribe(listener)
        await queue.mark_ws_connected(token, False)


async def _verify_turnstile(secret: str, token: str, remote_ip: str | None) -> bool:
    payload = {"secret": secret, "response": token}
    if remote_ip:
        payload["remoteip"] = remote_ip
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(TURNSTILE_VERIFY_URL, data=payload)
        data = resp.json()
        if not data.get("success"):
            logger.warning("Turnstile verification failed: %s", data.get("error-codes"))
        return bool(data.get("success"))
    except Exception:
        logger.exception("Turnstile verification raised")
        return False
