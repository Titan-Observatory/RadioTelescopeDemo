import { useEffect, useRef, useState } from 'react';

import type { QueueStatus } from '../queue';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
    onloadTurnstileCallback?: () => void;
  }
}

const TURNSTILE_SCRIPT_ID = 'cf-turnstile-script';
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit';

// ─── SVG path helpers ──────────────────────────────────────────────────────────

function gaussianPts(cx: number, sigma: number, amp: number, base: number, w: number): string[] {
  const pts: string[] = [];
  for (let x = 0; x <= w; x += 3)
    pts.push(`${x},${(base - amp * Math.exp(-0.5 * ((x - cx) / sigma) ** 2)).toFixed(1)}`);
  return pts;
}

function gaussianLine(cx: number, sigma: number, amp: number, base: number, w: number): string {
  return `M ${gaussianPts(cx, sigma, amp, base, w).join(' L ')}`;
}

function gaussianFill(cx: number, sigma: number, amp: number, base: number, w: number): string {
  return `M 0,${base} L ${gaussianPts(cx, sigma, amp, base, w).join(' L ')} L ${w},${base} Z`;
}

function sineWave(y0: number, lambda: number, amp: number, w: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= w; x += 2)
    pts.push(`${x},${(y0 - amp * Math.sin((x / lambda) * 2 * Math.PI)).toFixed(1)}`);
  return `M ${pts.join(' L ')}`;
}

function noiseFloor(base: number, w: number, amp: number): string {
  const pts: string[] = [];
  let v = 0;
  for (let x = 0; x <= w; x += 4) {
    v = v * 0.55 + (Math.sin(x * 0.43 + 7) * 0.5 + Math.sin(x * 0.19 + 3) * 0.5) * amp;
    pts.push(`${x},${(base + v).toFixed(1)}`);
  }
  return `M ${pts.join(' L ')}`;
}

// ─── Precomputed path data ─────────────────────────────────────────────────────

// Hero spectrum: 600×135, single H I peak centred at 300
const HW = 600;
const HERO_FILL  = gaussianFill(300, 62, 74, 112, HW);
const HERO_LINE  = gaussianLine(300, 62, 74, 112, HW);
const HERO_NOISE = noiseFloor(112, HW, 3.5);

// Doppler diagram: three sine waves stacked in a 600×190 viewport
const WAVE_W         = 330;
const SINE_COMPRESSED = sineWave(45,  24, 16, WAVE_W);
const SINE_REST       = sineWave(105, 38, 16, WAVE_W);
const SINE_STRETCHED  = sineWave(165, 60, 16, WAVE_W);

// Observation spectrum: 680×200, three peaks at different velocities
const OW = 680, OBASE = 142;
const OBS_APP_FILL  = gaussianFill(190, 32, 74, OBASE, OW);
const OBS_APP_LINE  = gaussianLine(190, 32, 74, OBASE, OW);
const OBS_REST_FILL = gaussianFill(340, 26, 38, OBASE, OW);
const OBS_REST_LINE = gaussianLine(340, 26, 38, OBASE, OW);
const OBS_REC_FILL  = gaussianFill(490, 38, 82, OBASE, OW);
const OBS_REC_LINE  = gaussianLine(490, 38, 82, OBASE, OW);
const OBS_NOISE     = noiseFloor(OBASE, OW, 4);

// ─── SVG components ────────────────────────────────────────────────────────────

function HeroSpectrum() {
  return (
    <svg
      viewBox="0 0 600 135"
      className="h1-svg"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="h1HeroGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#ffbc42" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[30, 55, 80, 105].map(y => (
        <line key={y} x1="0" y1={y} x2={HW} y2={y} stroke="#1a1d2e" strokeWidth="1" />
      ))}
      {[100, 200, 300, 400, 500].map(x => (
        <line key={x} x1={x} y1="0" x2={x} y2="115" stroke="#1a1d2e" strokeWidth="1" />
      ))}
      <path d={HERO_NOISE} fill="none" stroke="#2a2e48" strokeWidth="1.5" />
      <path d={HERO_FILL}  fill="url(#h1HeroGrad)" />
      <path d={HERO_LINE}  fill="none" stroke="#ffbc42" strokeWidth="2.5" strokeLinejoin="round" />
      <line x1="300" y1="6" x2="300" y2="115" stroke="#ffbc42" strokeWidth="1" strokeDasharray="4,3" opacity="0.45" />
      <line x1="0" y1="115" x2={HW} y2="115" stroke="#232640" strokeWidth="1" />
      <text x="20"   y="129" fill="#3a3f5e" fontSize="10" fontFamily="ui-monospace,monospace">higher freq →</text>
      <text x="300"  y="129" textAnchor="middle" fill="#9b9ece" fontSize="11" fontFamily="ui-monospace,monospace">1420.4 MHz</text>
      <text x="580"  y="129" textAnchor="end"    fill="#3a3f5e" fontSize="10" fontFamily="ui-monospace,monospace">← lower freq</text>
    </svg>
  );
}

function DopplerDiagram() {
  const lx = 355;
  return (
    <svg
      viewBox="0 0 600 190"
      className="h1-svg"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <line x1="0" y1="75"  x2="345" y2="75"  stroke="#1a1d2e" strokeWidth="1" />
      <line x1="0" y1="135" x2="345" y2="135" stroke="#1a1d2e" strokeWidth="1" />
      <line x1="345" y1="0" x2="345" y2="190" stroke="#232640" strokeWidth="1" />
      <line x1="0" y1="45"  x2="345" y2="45"  stroke="#1a1d2e" strokeWidth="1" strokeDasharray="2,5" />
      <line x1="0" y1="105" x2="345" y2="105" stroke="#1a1d2e" strokeWidth="1" strokeDasharray="2,5" />
      <line x1="0" y1="165" x2="345" y2="165" stroke="#1a1d2e" strokeWidth="1" strokeDasharray="2,5" />

      <path d={SINE_COMPRESSED} fill="none" stroke="#5ba4f5" strokeWidth="2"   strokeLinejoin="round" />
      <path d={SINE_REST}       fill="none" stroke="#ffbc42" strokeWidth="2"   strokeLinejoin="round" />
      <path d={SINE_STRETCHED}  fill="none" stroke="#ff7a4d" strokeWidth="2"   strokeLinejoin="round" />

      <text x={lx} y="38"  fill="#5ba4f5" fontSize="13" fontWeight="600">Approaching</text>
      <text x={lx} y="54"  fill="#8ab4d8" fontSize="11">Higher frequency</text>
      <text x={lx} y="68"  fill="#7a9bbd" fontSize="11" fontFamily="ui-monospace,monospace">f &gt; 1420.4 MHz</text>

      <text x={lx} y="98"  fill="#ffbc42" fontSize="13" fontWeight="600">At rest</text>
      <text x={lx} y="114" fill="#c9a87a" fontSize="11">Rest frequency</text>
      <text x={lx} y="128" fill="#b8935a" fontSize="11" fontFamily="ui-monospace,monospace">f = 1420.4 MHz</text>

      <text x={lx} y="158" fill="#ff7a4d" fontSize="13" fontWeight="600">Receding</text>
      <text x={lx} y="174" fill="#cc8c6e" fontSize="11">Lower frequency</text>
      <text x={lx} y="188" fill="#b87a5a" fontSize="11" fontFamily="ui-monospace,monospace">f &lt; 1420.4 MHz</text>
    </svg>
  );
}

function ObservationSpectrum() {
  const appX = 190, restX = 340, recX = 490, axisY = 152;
  return (
    <svg
      viewBox={`0 0 ${OW} 200`}
      className="h1-svg h1-svg-wide"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="h1AppGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#5ba4f5" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#5ba4f5" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="h1RestGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#ffbc42" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="h1RecGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#ff7a4d" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ff7a4d" stopOpacity="0" />
        </linearGradient>
      </defs>

      {[40, 80, 120].map(y => (
        <line key={y} x1="0" y1={y} x2={OW} y2={y} stroke="#1a1d2e" strokeWidth="1" />
      ))}

      <line x1={restX} y1="0" x2={restX} y2={axisY} stroke="#ffbc42" strokeWidth="1" strokeDasharray="5,4" opacity="0.35" />
      <path d={OBS_NOISE}    fill="none" stroke="#252840" strokeWidth="1.5" />
      <path d={OBS_APP_FILL}  fill="url(#h1AppGrad)" />
      <path d={OBS_REST_FILL} fill="url(#h1RestGrad)" />
      <path d={OBS_REC_FILL}  fill="url(#h1RecGrad)" />
      <path d={OBS_APP_LINE}  fill="none" stroke="#5ba4f5" strokeWidth="2" />
      <path d={OBS_REST_LINE} fill="none" stroke="#ffbc42" strokeWidth="1.5" />
      <path d={OBS_REC_LINE}  fill="none" stroke="#ff7a4d" strokeWidth="2" />

      <line x1="0" y1={axisY} x2={OW} y2={axisY} stroke="#232640" strokeWidth="1" />

      <line x1={appX}  y1={OBASE - 74} x2={appX}  y2={axisY + 8} stroke="#5ba4f5" strokeWidth="1" opacity="0.4" />
      <line x1={restX} y1={OBASE - 38} x2={restX} y2={axisY + 8} stroke="#ffbc42" strokeWidth="1" opacity="0.35" />
      <line x1={recX}  y1={OBASE - 82} x2={recX}  y2={axisY + 8} stroke="#ff7a4d" strokeWidth="1" opacity="0.4" />

      <text x={appX}  y={axisY + 22} textAnchor="middle" fill="#5ba4f5" fontSize="12" fontWeight="600">Approaching gas</text>
      <text x={appX}  y={axisY + 36} textAnchor="middle" fill="#8ab4d8" fontSize="10">moving toward us</text>

      <text x={restX} y={axisY + 22} textAnchor="middle" fill="#c8a872" fontSize="11">rest frequency</text>
      <text x={restX} y={axisY + 36} textAnchor="middle" fill="#9b9ece" fontSize="10" fontFamily="ui-monospace,monospace">1420.4 MHz</text>

      <text x={recX}  y={axisY + 22} textAnchor="middle" fill="#ff7a4d" fontSize="12" fontWeight="600">Receding gas</text>
      <text x={recX}  y={axisY + 36} textAnchor="middle" fill="#cc8c6e" fontSize="10">moving away from us</text>
    </svg>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  status: QueueStatus | null;
  joining: boolean;
  joinError: string | null;
  siteKey: string | null;
  turnstileEnabled: boolean;
  onJoin: (token: string | null) => Promise<void>;
  hasControl: boolean;
  onContinue: () => void;
}

export function QueuePage({
  status, joining, joinError, siteKey, turnstileEnabled, onJoin, hasControl, onContinue,
}: Props) {
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const autoJoinedTokenRef = useRef<string | null>(null);
  const inQueue = (status?.position ?? -1) >= 0;

  useEffect(() => {
    if (!turnstileEnabled) return;
    if (inQueue || joining) return;
    if (!captchaToken) return;
    if (autoJoinedTokenRef.current === captchaToken) return;
    autoJoinedTokenRef.current = captchaToken;
    void onJoin(captchaToken);
  }, [captchaToken, turnstileEnabled, inQueue, joining, onJoin]);

  useEffect(() => {
    if (!joinError || !turnstileEnabled) return;
    autoJoinedTokenRef.current = null;
    setCaptchaToken(null);
    if (window.turnstile && widgetIdRef.current) window.turnstile.reset(widgetIdRef.current);
  }, [joinError, turnstileEnabled]);

  // Mount the Turnstile widget inline into the queue card. Previously this
  // lived in a separate full-screen modal, which made it look like the
  // captcha had popped up "on another screen" rather than being part of the
  // join flow itself.
  useEffect(() => {
    if (inQueue || !turnstileEnabled || !siteKey) return;
    const renderWidget = () => {
      if (!widgetRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: siteKey,
        callback: (token: string) => setCaptchaToken(token),
        'error-callback': () => setCaptchaToken(null),
        'expired-callback': () => setCaptchaToken(null),
      });
    };
    if (window.turnstile) { renderWidget(); return; }
    window.onloadTurnstileCallback = renderWidget;
    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement('script');
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }, [inQueue, turnstileEnabled, siteKey]);

  // Non-turnstile flow: nothing to verify, so a plain landing page is fine.
  if (!inQueue && !turnstileEnabled) {
    return (
      <div className="queue-landing">
        <div className="queue-card">
          <h1>Radio Telescope</h1>
          <p>This telescope is shared with other users. Join the queue to take control.</p>
          <button className="action-button" disabled={joining} onClick={() => void onJoin(null)}>
            {joining ? 'Joining…' : 'Join queue'}
          </button>
          {joinError && <p className="banner banner-error">{joinError}</p>}
        </div>
      </div>
    );
  }

  // Turnstile flow + still-joining: render the full waiting page underneath
  // so the captcha modal opens on top of the same UI the user will see once
  // they're in the queue, rather than a near-empty landing card.

  return (
    <div className="queue-waiting">
      <header className="queue-header">
        <div className="queue-header-inner">
          <div className="queue-header-title">
            <h1>{inQueue ? 'You are in the queue' : 'Joining the queue'}</h1>
            <p className="queue-header-sub">
              {inQueue
                ? "Hold tight — you'll get control when it's your turn."
                : 'Complete the quick verification to take your place in line.'}
            </p>
          </div>
          <div className="queue-header-status">
            <span className="queue-header-label">Position</span>
            <strong className="queue-header-position">
              {inQueue ? `#${status!.position}` : '—'}
            </strong>
            {inQueue && status!.queue_length > 0 && (
              <span className="queue-header-waiting">{status!.queue_length} waiting</span>
            )}
          </div>
          {inQueue && hasControl && (
            <button className="action-button" onClick={onContinue}>
              Continue to telescope
            </button>
          )}
        </div>
      </header>

      <main className="h1-page">

        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <section className="h1-hero">
          <div className="h1-hero-inner">
            <div className="h1-hero-text">
              <span className="h1-eyebrow">While you wait</span>
              <h2 className="h1-hero-title">The 21-cm Hydrogen Line</h2>
              <p className="h1-hero-sub">Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
            </div>
            <div className="h1-hero-visual">
              <HeroSpectrum />
              <p className="h1-visual-caption">
                The characteristic 1420.4 MHz emission peak from neutral hydrogen gas
              </p>
            </div>
          </div>
        </section>

        {/* ── Spin-flip section ─────────────────────────────────────────────── */}
        <section className="h1-spinflip">
          <div className="h1-spinflip-inner">
            <div className="h1-spinflip-text">
              <h2 className="h1-section-heading">The spin-flip transition</h2>
              <p className="h1-section-body">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
              <p className="h1-section-body">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
            </div>
            <div className="h1-spinflip-visual">
              {/* Animation goes here */}
            </div>
          </div>
        </section>

        {/* ── Doppler section ───────────────────────────────────────────────── */}
        <section className="h1-doppler">
          <div className="h1-doppler-inner">
            <div className="h1-doppler-text">
              <h2 className="h1-section-heading">The Doppler Effect</h2>
              <p className="h1-section-body">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>
              <p className="h1-section-body">Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est qui dolorem ipsum quia dolor sit amet.</p>
            </div>
            <div className="h1-doppler-visual">
              <DopplerDiagram />
              <p className="h1-visual-caption">
                Frequency shift is proportional to radial velocity along the line of sight
              </p>
            </div>
          </div>
        </section>

        {/* ── Observation section ───────────────────────────────────────────── */}
        <section className="h1-observe">
          <div className="h1-observe-inner">
            <h2 className="h1-section-heading">What you'll see in the spectrum</h2>
            <p className="h1-section-body">Lorem ipsum dolor sit amet, consectetur adipiscing elit. At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.</p>
            <div className="h1-observe-visual">
              <ObservationSpectrum />
            </div>
            <p className="h1-visual-caption">
              Multiple peaks appear when the beam passes through gas clouds moving at different radial velocities — each peak is a separate arm of the galaxy
            </p>
          </div>
        </section>


      </main>

      {!inQueue && turnstileEnabled && (
        <div className="captcha-modal-overlay">
          <div className="captcha-modal">
            <div className="captcha-modal-header">
              <h2>Verify to join</h2>
            </div>
            <p className="captcha-modal-body">Complete the check below to join the queue.</p>
            <div className="cf-turnstile" ref={widgetRef} />
            <p className="queue-status-line">
              {joining
                ? 'Joining…'
                : captchaToken
                  ? 'Verified — joining queue…'
                  : 'Waiting for verification…'}
            </p>
            {joinError && <p className="banner banner-error">{joinError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
