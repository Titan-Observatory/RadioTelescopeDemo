import { useEffect, useState } from 'react';

import { DopplerAnimation } from './QueuePage';

declare global {
  interface Window {
    __setDopplerRenderTime?: (timeSeconds: number) => void;
  }
}

// Offscreen render target used by scripts/render-doppler-frames.mjs to capture
// the queue-page Doppler animation as a sequence of PNGs.
export function DopplerRenderHarness() {
  const [timeSeconds, setTimeSeconds] = useState(0);

  useEffect(() => {
    window.__setDopplerRenderTime = setTimeSeconds;
    return () => { delete window.__setDopplerRenderTime; };
  }, []);

  return (
    <div style={{ width: 900, padding: 0, background: '#080b16' }}>
      <div className="doppler-render-target">
        <DopplerAnimation renderTimeSeconds={timeSeconds} />
      </div>
    </div>
  );
}
