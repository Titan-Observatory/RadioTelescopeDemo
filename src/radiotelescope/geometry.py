"""Geometry helpers for the pointing pipeline.

These live above the API layer so other backends (scripts, planners, tests)
can use them without importing FastAPI. The matching TypeScript copies in
``frontend/src/lib/altaz.ts`` are kept manually in sync — there is no
client-side route to invoke this code, and inlined feedback during the user's
click on the sky map needs synchronous local execution.
"""
from __future__ import annotations

import math
from collections.abc import Sequence


def normalise_azimuth(azimuth_deg: float) -> float:
    """Wrap an azimuth into ``[0, 360)`` so 360° collapses to 0°."""
    azimuth = azimuth_deg % 360.0
    return 0.0 if math.isclose(azimuth, 360.0) else azimuth


def unwrap_azimuth(azimuth_deg: float, reference_deg: float) -> float:
    """Shift ``azimuth_deg`` by multiples of 360 to land within 180° of the reference.

    Used to flatten azimuth wrap-around (350° → 0°) before geometric
    comparisons against a fixed-orientation reference point.
    """
    while azimuth_deg - reference_deg > 180.0:
        azimuth_deg -= 360.0
    while azimuth_deg - reference_deg < -180.0:
        azimuth_deg += 360.0
    return azimuth_deg


def point_in_triangle(
    point: tuple[float, float],
    triangle: Sequence[tuple[float, float]],
    epsilon: float = 1e-9,
) -> bool:
    """True if ``point`` is inside the 2-D triangle (half-plane sign test)."""
    px, py = point
    (ax, ay), (bx, by), (cx, cy) = triangle

    def sign(x1: float, y1: float, x2: float, y2: float, x3: float, y3: float) -> float:
        return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)

    d1 = sign(px, py, ax, ay, bx, by)
    d2 = sign(px, py, bx, by, cx, cy)
    d3 = sign(px, py, cx, cy, ax, ay)
    has_negative = d1 < -epsilon or d2 < -epsilon or d3 < -epsilon
    has_positive = d1 > epsilon or d2 > epsilon or d3 > epsilon
    return not (has_negative and has_positive)


__all__ = ("normalise_azimuth", "unwrap_azimuth", "point_in_triangle")
