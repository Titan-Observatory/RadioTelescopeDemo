from __future__ import annotations

HARD_ALTITUDE_MIN_DEG = 30.0
HARD_ALTITUDE_MAX_DEG = 70.0
HARD_AZIMUTH_MIN_DEG = 55.0
HARD_AZIMUTH_MAX_DEG = 190.0


def inside_hard_safety_limits(altitude_deg: float, azimuth_deg: float) -> bool:
    return (
        HARD_ALTITUDE_MIN_DEG <= altitude_deg <= HARD_ALTITUDE_MAX_DEG
        and HARD_AZIMUTH_MIN_DEG <= azimuth_deg <= HARD_AZIMUTH_MAX_DEG
    )


def jog_moves_outside_hard_limits(direction: str, altitude_deg: float, azimuth_deg: float) -> bool:
    if direction == "up":
        return altitude_deg >= HARD_ALTITUDE_MAX_DEG
    if direction == "down":
        return altitude_deg <= HARD_ALTITUDE_MIN_DEG
    if direction == "west":
        return azimuth_deg <= HARD_AZIMUTH_MIN_DEG
    if direction == "east":
        return azimuth_deg >= HARD_AZIMUTH_MAX_DEG
    return True
