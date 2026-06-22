#!/usr/bin/env python3
"""Bake the inferno colormap into a local HiPS's PNG tiles.

The frontend ships a local mirror of the HI4PI/NHI hydrogen-line HiPS under
``public/hips/P_HI4PI_NHI`` (see the SkyMap component). The published HiPS
carries 32-bit-float FITS tiles plus grayscale PNG previews. Aladin can colorize
the FITS at runtime (colormap + stretch in the shader), but that means fetching
and decoding multi-KB float tiles on every pan/zoom — janky when served from the
dev server / platform rather than the CDS CDN.

Instead we pre-render the PNG tiles with the same asinh stretch + inferno
colormap Aladin would apply, so the frontend can load lightweight PNG tiles
(``imgFormat: 'png'``, no runtime colormap) and still show the inferno map.

Re-run this whenever the local mirror is re-downloaded. It overwrites every
``Npix*.png`` (and ``Allsky.png``) in place from the sibling ``.fits``.

    python platform/frontend/scripts/colorize_hips.py \
        platform/frontend/public/hips/P_HI4PI_NHI

Requires: numpy, pillow, matplotlib.
"""
from __future__ import annotations

import glob
import os
import sys

import matplotlib
import numpy as np
from PIL import Image

# hips_pixel_cut from the HiPS properties + Aladin's default asinh stretch.
LO, HI, ASINH_A = 2.286e20, 2.056e22, 0.1
LUT = (matplotlib.colormaps["inferno"](np.linspace(0, 1, 256))[:, :3] * 255).round().astype(np.uint8)


def read_fits(path: str) -> np.ndarray:
    """Minimal reader for a single-HDU BITPIX=-32 image (HiPS tiles)."""
    raw = open(path, "rb").read()
    hdr: dict[str, str] = {}
    i = 0
    while True:
        card = raw[i : i + 80].decode("ascii", "replace")
        i += 80
        if card[:8].strip() == "END":
            break
        if "=" in card:
            hdr[card[:8].strip()] = card[9:].split("/")[0].strip()
    data_start = ((i + 2879) // 2880) * 2880
    nx, ny = int(hdr["NAXIS1"]), int(hdr["NAXIS2"])
    arr = (
        np.frombuffer(raw[data_start : data_start + nx * ny * 4], dtype=">f4")
        .astype(np.float32)
        .reshape(ny, nx)
    )
    bzero, bscale = float(hdr.get("BZERO", 0)), float(hdr.get("BSCALE", 1))
    return arr * bscale + bzero


def colorize(arr: np.ndarray) -> np.ndarray:
    """asinh-stretch within the pixel cut, map through inferno, flip to PNG orientation."""
    finite = np.isfinite(arr)
    norm = np.clip((np.where(finite, arr, LO) - LO) / (HI - LO), 0, 1)
    stretched = np.arcsinh(norm / ASINH_A) / np.arcsinh(1 / ASINH_A)
    idx = np.clip((stretched * 255).round(), 0, 255).astype(np.uint8)
    alpha = np.where(finite, 255, 0).astype(np.uint8)  # no-data -> transparent
    rgba = np.dstack([LUT[idx], alpha])
    return np.flipud(rgba)  # FITS is bottom-up; HiPS PNG tiles are top-down


def main(root: str) -> None:
    fits_files = sorted(glob.glob(os.path.join(root, "Norder*", "Dir*", "Npix*.fits")))
    allsky = glob.glob(os.path.join(root, "Norder*", "Allsky.fits"))
    targets = fits_files + allsky
    if not targets:
        sys.exit(f"no FITS tiles found under {root!r}")
    for fp in targets:
        Image.fromarray(colorize(read_fits(fp))).save(fp[:-5] + ".png")
    print(f"recolored {len(targets)} PNG tiles under {root}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "platform/frontend/public/hips/P_HI4PI_NHI")
