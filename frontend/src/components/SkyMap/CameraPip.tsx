import { Maximize2 } from 'lucide-react';
import { useEffect, useState } from 'react';


export function CameraPip({ swapped, onToggleSwap }: { swapped: boolean; onToggleSwap: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState('Cam A');
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/camera/status')
      .then((r) => r.json())
      .then((d: { enabled: boolean; label: string }) => {
        setEnabled(d.enabled);
        setLabel(d.label);
      })
      .catch(() => {/* non-critical */});
  }, []);

  if (!enabled) return null;

  return (
    <div className={`cam-pip${error ? ' cam-pip-error' : ''}${swapped ? ' cam-pip-swapped' : ''}`}>
      <img
        className="cam-pip-feed"
        src="/api/camera/stream"
        alt="Camera feed"
        onError={() => {
          setError(true);
          setEnabled(false);
        }}
        onLoad={() => setError(false)}
      />
      {error ? (
        <div className="cam-pip-offline">No signal</div>
      ) : (
        <div className="cam-pip-live"><span className="cam-pip-dot" />LIVE</div>
      )}
      <button
        type="button"
        className="cam-pip-fullscreen"
        onClick={onToggleSwap}
        title={swapped ? 'Restore sky map' : 'Swap with sky map'}
        aria-label={swapped ? 'Restore sky map' : 'Swap with sky map'}
        aria-pressed={swapped}
      >
        <Maximize2 size={13} />
      </button>
      <div className="cam-pip-label">{label}</div>
    </div>
  );
}
