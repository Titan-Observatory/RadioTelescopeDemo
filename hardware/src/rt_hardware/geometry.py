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


def point_in_polygon(
    point: tuple[float, float],
    polygon: Sequence[tuple[float, float]],
) -> bool:
    """Ray-casting point-in-polygon test for an arbitrary N-vertex polygon."""
    px, py = point
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


__all__ = ("normalise_azimuth", "unwrap_azimuth", "point_in_polygon")
