from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from rt_platform.api.log_files import append_jsonl_with_rotation
from rt_platform import loki

logger = logging.getLogger(__name__)
router = APIRouter(tags=["feedback"])

_write_lock = asyncio.Lock()


class FeedbackRequest(BaseModel):
    rating: int = Field(ge=1, le=5)
    message: str = Field(default="", max_length=2000)


@router.post("/api/feedback")
async def submit_feedback(body: FeedbackRequest, request: Request) -> dict[str, bool]:
    log_path = Path(request.app.state.config.feedback_log_path)
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "rating": body.rating,
        "message": body.message,
    }
    async with _write_lock:
        append_jsonl_with_rotation(log_path, entry, request.app.state.config.feedback_log_max_bytes)
    loki.push("rt_feedback", entry)
    logger.info("Feedback recorded: rating=%d", body.rating)
    return {"ok": True}
