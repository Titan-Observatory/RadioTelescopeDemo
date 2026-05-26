"""Shared camera capture session.

Owns a single `cv2.VideoCapture` so both the MJPEG stream and the per-frame
snapshot endpoint can share the underlying V4L2 device (which usually only
allows one opener). Lazy-opens on first use, closes after a short idle period
to release the hardware, and serializes reads behind an `asyncio.Lock`.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger("radiotelescope.camera")

try:
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False


class CameraService:
    """Lazy, refcountless, idle-closing shared camera capture.

    Opens on first acquire; closes the device after `idle_close_s` seconds with
    no activity so other processes (or another open attempt) can take over.
    """

    def __init__(
        self,
        device: int,
        width: int,
        height: int,
        *,
        idle_close_s: float = 10.0,
        drain_frames: int = 4,
    ) -> None:
        self._device = device
        self._width = width
        self._height = height
        self._idle_close_s = idle_close_s
        self._drain_frames = drain_frames
        self._lock = asyncio.Lock()
        self._cap = None  # type: ignore[assignment]
        self._last_use = 0.0
        self._closer_task: Optional[asyncio.Task] = None
        self._stopping = False

    @property
    def available(self) -> bool:
        return _CV2

    def _open_blocking(self):
        cap = cv2.VideoCapture(self._device)
        if not cap.isOpened():
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        # Smallest internal buffer we can request. Not all backends honor this,
        # but when they do it keeps `read()` close to real-time.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        return cap

    def _read_fresh_blocking(self) -> Optional[bytes]:
        cap = self._cap
        if cap is None:
            return None
        # Drain any stale frames the driver has buffered, then retrieve the
        # newest. `grab()` is cheap; `retrieve()` does the decode.
        for _ in range(self._drain_frames):
            cap.grab()
        ok, frame = cap.read()
        if not ok or frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not ok:
            return None
        return buf.tobytes()

    def _release_blocking(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None

    async def _ensure_open(self) -> bool:
        if not _CV2:
            return False
        if self._cap is not None:
            return True
        loop = asyncio.get_running_loop()
        cap = await loop.run_in_executor(None, self._open_blocking)
        if cap is None:
            return False
        self._cap = cap
        logger.info("Camera opened (device=%s)", self._device)
        return True

    async def acquire_jpeg(self) -> Optional[bytes]:
        """Return a freshly-captured JPEG, or None if the camera is unavailable."""
        if not _CV2:
            return None
        async with self._lock:
            if not await self._ensure_open():
                return None
            loop = asyncio.get_running_loop()
            try:
                data = await loop.run_in_executor(None, self._read_fresh_blocking)
            except Exception as exc:
                logger.warning("Camera read failed, closing: %s", exc)
                await loop.run_in_executor(None, self._release_blocking)
                return None
            if data is None:
                # Read failed — drop the cap so the next call retries cleanly.
                await loop.run_in_executor(None, self._release_blocking)
                return None
            self._last_use = time.monotonic()
            self._schedule_idle_close()
            return data

    async def is_live(self) -> bool:
        """Cheap availability probe: try one acquire."""
        return await self.acquire_jpeg() is not None

    def _schedule_idle_close(self) -> None:
        if self._stopping:
            return
        if self._closer_task is None or self._closer_task.done():
            self._closer_task = asyncio.create_task(self._idle_close_loop())

    async def _idle_close_loop(self) -> None:
        while True:
            wait = self._idle_close_s - (time.monotonic() - self._last_use)
            if wait <= 0:
                break
            await asyncio.sleep(wait)
        async with self._lock:
            if time.monotonic() - self._last_use >= self._idle_close_s and self._cap is not None:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, self._release_blocking)
                logger.info("Camera idle-closed after %.1fs", self._idle_close_s)

    async def stop(self) -> None:
        self._stopping = True
        if self._closer_task is not None:
            self._closer_task.cancel()
            try:
                await self._closer_task
            except (asyncio.CancelledError, Exception):
                pass
        async with self._lock:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._release_blocking)
