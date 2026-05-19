import { Monitor, X } from 'lucide-react';
import { useState } from 'react';

const MOBILE_HINT_KEY = 'rt-mobile-hint-dismissed';

export function MobileHint() {
  const [visible, setVisible] = useState(() =>
    typeof window !== 'undefined' &&
    window.innerWidth <= 640 &&
    !localStorage.getItem(MOBILE_HINT_KEY),
  );

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(MOBILE_HINT_KEY, '1');
    setVisible(false);
  };

  return (
    <div className="mobile-hint" role="dialog" aria-label="Desktop recommendation">
      <Monitor size={16} className="mobile-hint-icon" aria-hidden="true" />
      <p className="mobile-hint-text">
        For the best experience, open this page on a desktop browser.
      </p>
      <button type="button" className="mobile-hint-close" onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}
