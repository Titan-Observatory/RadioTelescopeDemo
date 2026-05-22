from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def append_jsonl_with_rotation(path: Path, entry: dict[str, Any], max_bytes: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size >= max_bytes:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path.replace(path.with_name(f"{path.stem}.{stamp}{path.suffix}"))
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, default=str) + "\n")
