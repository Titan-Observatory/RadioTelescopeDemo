/**
 * Draws the sun as an accurately-sized disc.
 * r is the pixel radius derived from the current Aladin projection so the
 * disc matches the sun's true ~0.53° angular diameter at whatever zoom level
 * the viewer is at.
 */
export function drawSunIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  // Limb darkening: centre is near-white, edge deepens to amber
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  disc.addColorStop(0,   '#fffde8');  // bright white-yellow core
  disc.addColorStop(0.55, '#ffe030'); // yellow mid-disc
  disc.addColorStop(1,   '#ffb000');  // amber limb
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = disc;
  ctx.fill();
}


/**
 * Draws the moon disc with the correct phase shape.
 *
 * Uses the two-arc path technique: the lit region is bounded by an outer
 * semicircle on the lit side and the terminator ellipse arc on the other
 * side, then filled in a single path — no masking or composite ops needed.
 *
 * fraction : 0 = new moon, 1 = full moon
 * waxing   : true → lit on the right, false → lit on the left
 */
export function drawMoonIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fraction: number,
  waxing: boolean,
): void {
  // Subtle corona
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.4);
  glow.addColorStop(0,   'rgba(200, 218, 255, 0.22)');
  glow.addColorStop(1,   'rgba(180, 200, 255, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.4, 0, 2 * Math.PI);
  ctx.fillStyle = glow;
  ctx.fill();

  // c runs −1 (new) → 0 (quarter) → +1 (full)
  const c  = 2 * fraction - 1;
  // Half-width of the terminator ellipse; small epsilon avoids a degenerate arc
  const rx = Math.max(0.5, Math.abs(c) * r);

  // Dark disc — shadow side fill so the moon is opaque against the survey
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = '#0c1a2e';
  ctx.fill();

  // ── Phase shape ───────────────────────────────────────────────────────────
  // Path: outer semicircle (lit side) + terminator ellipse arc (closing return).
  // For gibbous (c > 0): ellipse bulges toward the dark side → counterclockwise.
  // For crescent (c < 0): ellipse bulges toward the lit side → clockwise.
  // Both arcs run top→bottom then bottom→top so the path closes perfectly.

  ctx.beginPath();
  if (waxing) {
    // Lit on the right
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);            // right semicircle ↓
    ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, c > 0); // terminator ↑
  } else {
    // Lit on the left
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, true);             // left semicircle ↓
    ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, c < 0); // terminator ↑
  }
  ctx.closePath();
  ctx.fillStyle = '#dde8ff';
  ctx.fill();

  // Disc outline — faint ring so a thin crescent or new moon is still locatable
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(180, 200, 255, 0.35)';
  ctx.lineWidth   = 1;
  ctx.stroke();
}


export function drawSatelliteIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color = '#f3cc6b',
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 8);

  ctx.shadowColor = 'rgba(243, 204, 107, 0.42)';
  ctx.shadowBlur = 12;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.fillStyle = 'rgba(5, 12, 24, 0.82)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;

  const bodyW = size * 0.56;
  const bodyH = size * 0.44;
  ctx.beginPath();
  ctx.roundRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH, 3);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(243, 204, 107, 0.22)';
  ctx.strokeStyle = 'rgba(255, 232, 158, 0.9)';
  ctx.lineWidth = 1.2;

  ctx.beginPath();
  ctx.rect(-size * 1.02, -size * 0.32, size * 0.5, size * 0.64);
  ctx.rect(size * 0.52, -size * 0.32, size * 0.5, size * 0.64);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-size * 0.52, 0);
  ctx.lineTo(-size * 0.28, 0);
  ctx.moveTo(size * 0.28, 0);
  ctx.lineTo(size * 0.52, 0);
  ctx.moveTo(0, -size * 0.22);
  ctx.lineTo(0, -size * 0.58);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, -size * 0.72, size * 0.12, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.restore();
}


export function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
