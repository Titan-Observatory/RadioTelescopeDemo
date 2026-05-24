/**
 * HydrogenAtom.tsx
 *
 * Animated depiction of a neutral hydrogen atom for the spin-flip explanation
 * panel. The sequence loops automatically:
 *
 *   1. Proton + electron start overlapping at centre (combined state).
 *   2. They separate to their natural side-by-side positions.
 *   3. Spin arrows and labels fade in.
 *   4. The electron arrow vibrates and snaps to the opposite orientation
 *      (hyperfine spin-flip event).
 *   5. Labels and arrows fade out.
 *   6. Particles recombine.
 *
 * ── Timing knobs ──────────────────────────────────────────────────────────
 * All durations are in seconds. Edit the TIMELINE object to change pacing.
 *
 * ── Flip animation knobs ──────────────────────────────────────────────────
 * FLIP.steps  — each entry is [rotOffset, scale, duration] for one vibration
 *               step. Add/remove entries or change magnitudes to taste.
 * FLIP.flash* — the bright-flash keyframe that precedes the snap.
 * FLIP.settle — how long the scale eases back to 1 after the snap.
 *
 * ── Visual knobs ──────────────────────────────────────────────────────────
 * Proton:   SVG metaball swarm — tweak circle radii / SMIL durations in
 *           ProtonSwarm().
 * Electron: Canvas Gaussian dot cloud — tweak the CLOUD object.
 * Arrow colour / glow: .hydrogen-atom-arrow in main.css.
 */

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';

// ── Sequence timing (seconds) ─────────────────────────────────────────────
const TIMELINE = {
  holdCombined:   1.8,
  separate:       2.0,
  fadeInUI:       1.0,
  holdBeforeFlip: 1.4,
  flipDuration:   0.85,  // must be >= sum of FLIP step durations + settle
  holdAfterFlip:  1.0,
  fadeOutUI:      1.0,
  recombine:      2.0,
  holdEnd:        1.2,
};

// ── Flip vibration (each row: [rotOffset°, scale, duration s]) ────────────
const FLIP = {
  steps: [
    [-1,  1.00, 0.06],
    [+2,  1.00, 0.06],
    [-3,  1.01, 0.06],
    [+5,  1.03, 0.06],
    [-7,  1.05, 0.06],
    [+9,  1.08, 0.06],
    [-11, 1.11, 0.06],
    [+13, 1.13, 0.06],
    [-14, 1.14, 0.06],
    [+15, 1.15, 0.06],
  ] as [number, number, number][],
  flashDuration: 0.04,
  flashFilter:   'brightness(3) drop-shadow(0 0 16px #fff)',
  preFlashFilter:'brightness(1.4) drop-shadow(0 0 6px rgba(255,230,168,0.6))',
  settle:        0.08,
};

// ── Electron cloud constants ───────────────────────────────────────────────
const CLOUD = {
  size:     200,
  sigma:    0.22,   // spread as fraction of size
  maxSigma:   2.8,  // hard cutoff in sigma, kept inside the visible glow
  taperSigma: 2.6,  // soft visual falloff inside the clipping boundary
  n:        950,
  onDurMin:  1, onDurMax:  4,
  offDurMin: 1, offDurMax: 5,
  bigDotChance: 0.08,
  bigDotR: 1.65, smallDotR: 1.0,
  fps: 30,
  glow: {
    inner:  [100, 160, 255] as [number,number,number],
    mid:    [64,  112, 220] as [number,number,number],
    outer:  [32,  58,  158] as [number,number,number],
    peak:   0.68,
    scale:  0.70,
    stops:  [0, 0.30, 0.60],
    alphas: [1, 0.72, 0.38],
  },
  dotColor:     [168, 204, 246] as [number,number,number],
  dotMaxAlpha:  0.30,
  dotTaperExp:  4.2,
  edgeTaperExp: 1.8,
  blur:         '2px',
};

// ─────────────────────────────────────────────────────────────────────────────

export function HydrogenAtomDepiction({ paused }: { paused?: boolean }) {
  const protonRef        = useRef<HTMLDivElement>(null);
  const electronRef      = useRef<HTMLDivElement>(null);
  const protonArrowRef   = useRef<HTMLSpanElement>(null);
  const electronArrowRef = useRef<HTMLSpanElement>(null); // stable ref — never remounted
  const electronCloudRef = useRef<HTMLSpanElement>(null);
  const protonLabelRef   = useRef<HTMLSpanElement>(null);
  const electronLabelRef = useRef<HTMLSpanElement>(null);
  const atomLabelRef     = useRef<HTMLSpanElement>(null);
  const photonRef        = useRef<HTMLCanvasElement>(null);
  const tlRef            = useRef<gsap.core.Timeline | null>(null);
  const offsetRef        = useRef(0);
  const arrowRotRef      = useRef(0); // tracks accumulated rotation so flips chain correctly

  // Snap to combined before first paint — no flash of separated state.
  useLayoutEffect(() => {
    const proton   = protonRef.current;
    const electron = electronRef.current;
    if (!proton || !electron) return;
    gsap.set([proton, electron], { xPercent: -50, yPercent: -50 });
    gsap.set(electronCloudRef.current, { scale: 1, transformOrigin: '50% 50%' });
    const pr = proton.getBoundingClientRect();
    const er = electron.getBoundingClientRect();
    offsetRef.current = ((er.left + er.width / 2) - (pr.left + pr.width / 2)) / 2;
    gsap.set(proton,   { x:  offsetRef.current });
    gsap.set(electron, { x: -offsetRef.current });
  }, []);

  useEffect(() => {
    const proton   = protonRef.current;
    const electron = electronRef.current;
    if (!proton || !electron) return;

    const offset = offsetRef.current;
    const ui = [
      protonArrowRef.current,
      electronArrowRef.current,
      protonLabelRef.current,
      electronLabelRef.current,
    ];
    const atomLabel = atomLabelRef.current;
    const electronCloud = electronCloudRef.current;

    // Flip animation built entirely in GSAP — no CSS keyframes, no React state,
    // no key= remounting. A stable ref means GSAP always has the right element.
    function triggerFlip() {
      const arrow = electronArrowRef.current;
      if (!arrow) return;

      const start = arrowRotRef.current;
      const end   = start + 180;
      arrowRotRef.current = end;

      const ft = gsap.timeline();

      // Vibrate with escalating amplitude.
      for (const [rotOff, scale, dur] of FLIP.steps) {
        ft.to(arrow, { rotation: start + rotOff, scale, duration: dur, ease: 'none' });
      }

      // Pre-flash glow, then bright flash.
      ft.to(arrow, {
        rotation: start - 11, scale: 1.12,
        filter: FLIP.preFlashFilter, duration: 0.03, ease: 'none',
      });
      ft.to(arrow, {
        rotation: start, scale: 1.4,
        filter: FLIP.flashFilter, duration: FLIP.flashDuration, ease: 'none',
      });

      // Instant snap to opposite orientation.
      ft.set(arrow, { rotation: end });

      // Settle back to neutral.
      ft.to(arrow, { scale: 1, filter: 'none', duration: FLIP.settle, ease: 'power2.out' });
    }

    function triggerPhoton() {
      const photon = photonRef.current;
      if (!photon) return;
      gsap.killTweensOf(photon);
      gsap.set(photon, { y: 0, opacity: 0 });
      const pt = gsap.timeline();
      pt.to(photon, { opacity: 1, duration: 0.5, ease: 'power2.in' });
      pt.to(photon, { y: -320, duration: 3.2, ease: 'power1.inOut' }, 0);
      pt.to(photon, { opacity: 0, duration: 0.9, ease: 'power2.out' }, 1.7);
    }

    const tl = gsap.timeline({ repeat: -1 });
    tlRef.current = tl;

    const T = TIMELINE;
    tl
      // Reset to always-parallel state at the top of each cycle (arrows invisible here).
      .call(() => {
        gsap.set(electronArrowRef.current, { rotation: 0 });
        gsap.set(electronCloud, { scale: 1 });
        gsap.set(atomLabel, { opacity: 1 });
        arrowRotRef.current = 0;
      })
      .to({}, { duration: T.holdCombined })
      .to(atomLabel, { opacity: 0, duration: 0.35, ease: 'power2.out' })
      .to([proton, electron], { x: 0, y: -34, duration: T.separate, ease: 'power3.inOut' })
      .to(electronCloud, { scale: 0.45, duration: T.separate, ease: 'power3.inOut' }, '<')
      .to(ui, { opacity: 1, duration: T.fadeInUI })
      .to({}, { duration: T.holdBeforeFlip })
      .call(triggerFlip)
      .to({}, { duration: T.flipDuration })
      .call(triggerPhoton)
      .to({}, { duration: T.holdAfterFlip })
      .to(ui, { opacity: 0, duration: T.fadeOutUI })
      .to(proton,   { x:  offset, y: 0, duration: T.recombine, ease: 'power3.inOut' })
      .to(electron, { x: -offset, y: 0, duration: T.recombine, ease: 'power3.inOut' }, '<')
      .to(electronCloud, { scale: 1, duration: T.recombine, ease: 'power3.inOut' }, '<')
      .to(atomLabel, { opacity: 1, duration: 0.45, ease: 'power2.out' })
      .to({}, { duration: T.holdEnd });

    if (paused) tl.pause();

    return () => {
      tl.kill();
      gsap.killTweensOf(photonRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tlRef.current) return;
    paused ? tlRef.current.pause() : tlRef.current.resume();
  }, [paused]);

  return (
    <div className="hydrogen-atom" aria-hidden data-paused={paused || undefined}>
      <PhotonRay canvasRef={photonRef} />
      <span ref={atomLabelRef} className="hydrogen-atom-title">Hydrogen Atom</span>
      <div ref={protonRef} className="hydrogen-atom-particle">
        <ProtonSwarm />
      </div>
      <div ref={electronRef} className="hydrogen-atom-particle">
        <ElectronCloud cloudRef={electronCloudRef} />
      </div>
      <div className="hydrogen-spin-readout hydrogen-spin-readout-proton">
        <span ref={protonArrowRef} className="hydrogen-atom-arrow">↑</span>
        <span ref={protonLabelRef} className="hydrogen-atom-label">proton spin</span>
      </div>
      <div className="hydrogen-spin-readout hydrogen-spin-readout-electron">
        <span ref={electronArrowRef} className="hydrogen-atom-arrow">↑</span>
        <span ref={electronLabelRef} className="hydrogen-atom-label">electron spin</span>
      </div>
    </div>
  );
}

// ── 21 cm photon: animated traveling wave packet ──────────────────────────

const PHOTON = {
  W: 52, H: 88,
  A: 12,      // amplitude px
  λ: 18,      // wavelength px
  σ: 18,      // Gaussian envelope sigma
  phaseRate: 0.28,  // radians per frame — controls oscillation speed
  color: '#22d3ee',  // tailwind cyan-400
  glowColor: '#06b6d4',
};

function PhotonRay({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const { W, H, A, λ, σ, phaseRate, color, glowColor } = PHOTON;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width  = W;
    canvas.height = H;

    const cx = W / 2, ctr = H / 2;
    let phase = 0, raf = 0;

    function tracePath(ctx: CanvasRenderingContext2D) {
      ctx.beginPath();
      for (let y = 0; y <= H; y++) {
        const env = Math.exp(-((y - ctr) ** 2) / (2 * σ * σ));
        const x   = cx + A * Math.sin((2 * Math.PI * y) / λ - phase) * env;
        y === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }

    function draw() {
      raf = requestAnimationFrame(draw);
      const ctx = canvas!.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);

      // Soft outer glow
      ctx.shadowBlur   = 22;
      ctx.shadowColor  = glowColor;
      ctx.strokeStyle  = color;
      ctx.lineWidth    = 4.5;
      ctx.lineCap      = 'round';
      ctx.lineJoin     = 'round';
      ctx.globalAlpha  = 0.35;
      tracePath(ctx);
      ctx.stroke();

      // Mid layer
      ctx.shadowBlur   = 10;
      ctx.globalAlpha  = 0.75;
      ctx.lineWidth    = 2.8;
      tracePath(ctx);
      ctx.stroke();

      // Bright core
      ctx.shadowBlur   = 4;
      ctx.shadowColor  = '#e0f7fa';
      ctx.strokeStyle  = '#cffafe';
      ctx.lineWidth    = 1.4;
      ctx.globalAlpha  = 1;
      tracePath(ctx);
      ctx.stroke();

      ctx.shadowBlur  = 0;
      ctx.globalAlpha = 1;
      phase += phaseRate;
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left:       '50%',
        top:        '50%',
        marginLeft: `-${W / 2}px`,
        marginTop:  `-${H / 2}px`,
        opacity:    0,
        pointerEvents: 'none',
      }}
    />
  );
}

// ── Proton: metaball goo swarm ────────────────────────────────────────────

function ProtonSwarm() {
  return (
    <span className="fuzzy fuzzy-proton fuzzy-goo">
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        <defs>
          <radialGradient id="fuzzy-proton-grad">
            <stop offset="0%"   stopColor="#ffd3d3" />
            <stop offset="55%"  stopColor="#e84a4a" />
            <stop offset="100%" stopColor="#8f1515" />
          </radialGradient>
          <filter id="goo-proton" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
            <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
          </filter>
        </defs>
        <g filter="url(#goo-proton)" fill="url(#fuzzy-proton-grad)">
          <circle r="11" cx="50" cy="50">
            <animate attributeName="cx" dur="0.65s" begin="0s"     values="50;60;44;52;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.92s" begin="-0.3s"  values="50;44;56;47;50" repeatCount="indefinite" />
          </circle>
          <circle r="10" cx="50" cy="50">
            <animate attributeName="cx" dur="0.78s" begin="-0.4s"  values="50;42;56;48;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.54s" begin="0s"     values="50;57;44;55;50" repeatCount="indefinite" />
          </circle>
          <circle r="9.5" cx="50" cy="50">
            <animate attributeName="cx" dur="0.42s" begin="-0.15s" values="50;53;45;58;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.68s" begin="-0.5s"  values="50;47;59;43;50" repeatCount="indefinite" />
          </circle>
          <circle r="9" cx="50" cy="50">
            <animate attributeName="cx" dur="1.00s" begin="-0.6s"  values="50;46;54;42;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.50s" begin="-0.2s"  values="50;54;43;58;50" repeatCount="indefinite" />
          </circle>
        </g>
      </svg>
    </span>
  );
}

// ── Electron: Gaussian dot cloud ──────────────────────────────────────────

function ElectronCloud({ cloudRef }: { cloudRef?: React.Ref<HTMLSpanElement> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { size: SIZE, sigma: SIGMA_FRAC, maxSigma, taperSigma, n: N,
            onDurMin, onDurMax, offDurMin, offDurMax,
            bigDotChance, bigDotR, smallDotR,
            fps, glow, dotColor, dotMaxAlpha, dotTaperExp, edgeTaperExp } = CLOUD;

    canvas.width  = SIZE;
    canvas.height = SIZE;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const sigma = SIZE * SIGMA_FRAC;
    const maxR = sigma * maxSigma;
    const taperR = sigma * taperSigma;

    function gaussSample(): [number, number] {
      let x: number, y: number;
      do {
        const u1 = Math.max(1e-9, Math.random());
        const mag = Math.sqrt(-2 * Math.log(u1)) * sigma;
        const ang = 2 * Math.PI * Math.random();
        x = cx + mag * Math.cos(ang);
        y = cy + mag * Math.sin(ang);
      } while (Math.hypot(x - cx, y - cy) > maxR);
      return [x, y];
    }

    type Dot = { x: number; y: number; r: number; on: boolean; ttl: number; onDur: number; offDur: number };

    const dots: Dot[] = Array.from({ length: N }, () => {
      const [x, y] = gaussSample();
      const onDur  = onDurMin  + Math.floor(Math.random() * (onDurMax  - onDurMin  + 1));
      const offDur = offDurMin + Math.floor(Math.random() * (offDurMax - offDurMin + 1));
      const startOn = Math.random() < 0.45;
      return { x, y, r: Math.random() < bigDotChance ? bigDotR : smallDotR,
               on: startOn, ttl: 1 + Math.floor(Math.random() * (startOn ? onDur : offDur)),
               onDur, offDur };
    });

    const FRAME_MS = 1000 / fps;
    let raf = 0, lastTime = 0;
    const [dr, dg, db] = dotColor;
    const [gi, gg, gb] = glow.inner;
    const [mi, mg, mb] = glow.mid;
    const [oi, og, ob] = glow.outer;

    function draw(now: number) {
      raf = requestAnimationFrame(draw);
      if (now - lastTime < FRAME_MS) return;
      lastTime = now;

      const ctx = canvas!.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, SIZE, SIZE);

      let visCount = 0, sumX = 0, sumY = 0;
      for (const d of dots) {
        if (--d.ttl <= 0) {
          d.on = !d.on;
          d.ttl = d.on ? d.onDur : d.offDur;
          if (d.on) [d.x, d.y] = gaussSample();
        }
        if (d.on) { visCount++; sumX += d.x; sumY += d.y; }
      }

      const gcx  = visCount > 0 ? sumX / visCount : cx;
      const gcy  = visCount > 0 ? sumY / visCount : cy;
      const norm  = visCount / (N * 0.45);
      const peak  = Math.min(glow.peak, norm * glow.scale);
      const grad  = ctx.createRadialGradient(gcx, gcy, 0, cx, cy, SIZE * 0.50);
      grad.addColorStop(glow.stops[0], `rgba(${gi},${gg},${gb},${peak})`);
      grad.addColorStop(glow.stops[1], `rgba(${mi},${mg},${mb},${(peak * glow.alphas[1]).toFixed(3)})`);
      grad.addColorStop(glow.stops[2], `rgba(${oi},${og},${ob},${(peak * glow.alphas[2]).toFixed(3)})`);
      grad.addColorStop(1,             'rgba(10,25,90,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SIZE, SIZE);

      for (const d of dots) {
        if (!d.on) continue;
        const dist = Math.hypot(d.x - cx, d.y - cy);
        const radialFade = Math.exp(-Math.pow(dist / taperR, dotTaperExp));
        const edgeFade = Math.pow(Math.max(0, 1 - dist / maxR), edgeTaperExp);
        const fade = radialFade * edgeFade;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${dr},${dg},${db},${(dotMaxAlpha * fade).toFixed(3)})`;
        ctx.fill();
      }
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span ref={cloudRef} className="fuzzy fuzzy-electron">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', filter: `blur(${CLOUD.blur})` }}
      />
    </span>
  );
}
