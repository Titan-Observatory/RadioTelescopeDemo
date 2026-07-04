"""Index over goesproc's output directory.

goesproc owns product creation: it runs with this directory as its working
directory and writes decoded files into handler-defined subtrees
(``images/goes19/2026-06-12/...``, ``emwin/...``). This store is a read-side
index for the HTTP API and frontend gallery — it rescans the tree for new
files, classifies them by extension, extracts text previews, and prunes the
oldest files past ``max_products``. The simulate backend writes demo files
into the same tree, so both backends share one ingestion path.

Scanning runs in a worker thread (it touches disk); the lock keeps it safe
against API reads from the event loop.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from pathlib import Path

from rt_hardware.models.state import GoesProduct

logger = logging.getLogger(__name__)

_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".txt": "text/plain",
    ".text": "text/plain",
}
_TEXT_PREVIEW_CHARS = 400
# goesproc writes files in one shot, but don't index anything mid-write.
_MIN_AGE_S = 1.0


def _kind_for(media_type: str) -> str:
    if media_type.startswith("image/"):
        return "image"
    if media_type.startswith("text/"):
        return "text"
    return "binary"


class ProductStore:
    def __init__(self, directory: Path, max_products: int = 200) -> None:
        self.directory = directory
        self._max = max_products
        self._lock = threading.Lock()
        self._by_id: dict[str, tuple[GoesProduct, Path]] = {}
        self.directory.mkdir(parents=True, exist_ok=True)
        self.scan()

    # ── Read side (event loop) ────────────────────────────────────────

    @property
    def total(self) -> int:
        with self._lock:
            return len(self._by_id)

    @property
    def last_product_at(self) -> float | None:
        with self._lock:
            newest = max((p.created_at for p, _ in self._by_id.values()), default=None)
        return newest

    def list(self, limit: int = 50) -> list[GoesProduct]:
        with self._lock:
            products = sorted(
                (p for p, _ in self._by_id.values()),
                key=lambda p: p.created_at,
                reverse=True,
            )
        return products[: max(0, limit)]

    def get(self, product_id: str) -> tuple[GoesProduct, Path] | None:
        with self._lock:
            entry = self._by_id.get(product_id)
        if entry is None or not entry[1].exists():
            return None
        return entry

    # ── Maintenance (worker thread) ───────────────────────────────────

    def scan(self) -> int:
        """Re-index the directory tree. Returns the number of new products."""
        now = time.time()
        seen: dict[str, tuple[GoesProduct, Path]] = {}
        added = 0
        try:
            paths = [p for p in self.directory.rglob("*") if p.is_file()]
        except OSError:
            logger.exception("Product scan failed for %s", self.directory)
            return 0
        with self._lock:
            for path in paths:
                rel = path.relative_to(self.directory)
                product_id = hashlib.sha1(str(rel).encode()).hexdigest()[:16]
                existing = self._by_id.get(product_id)
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if existing is not None and existing[0].size_bytes == stat.st_size:
                    seen[product_id] = existing
                    continue
                if now - stat.st_mtime < _MIN_AGE_S:
                    continue  # possibly mid-write; next scan picks it up
                product = self._build_product(product_id, path, rel, stat.st_size, stat.st_mtime)
                if product is None:
                    continue
                seen[product_id] = (product, path)
                if existing is None:
                    added += 1
            self._by_id = seen
            self._prune_locked()
        return added

    def _build_product(
        self, product_id: str, path: Path, rel: Path, size: int, mtime: float,
    ) -> GoesProduct | None:
        if size == 0:
            return None
        media_type = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
        kind = _kind_for(media_type)
        preview: str | None = None
        if kind == "text":
            try:
                preview = path.read_text(errors="replace")[:_TEXT_PREVIEW_CHARS].strip() or None
            except OSError:
                preview = None
        # as_posix() keeps the group identifier OS-independent (forward slashes)
        # so the API response is stable regardless of the server platform.
        group = rel.parent.as_posix() if rel.parent != Path(".") else None
        return GoesProduct(
            id=product_id,
            kind=kind,  # type: ignore[arg-type]
            name=path.name,
            group=group,
            size_bytes=size,
            created_at=mtime,
            media_type=media_type,
            preview=preview,
        )

    def _prune_locked(self) -> None:
        if len(self._by_id) <= self._max:
            return
        ordered = sorted(self._by_id.items(), key=lambda kv: kv[1][0].created_at)
        for product_id, (_, path) in ordered[: len(self._by_id) - self._max]:
            path.unlink(missing_ok=True)
            del self._by_id[product_id]


__all__ = ("ProductStore",)
