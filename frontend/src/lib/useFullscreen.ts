// Tracks the document's fullscreen state and exposes a toggle for a given
// element ref. Cheaper to subscribe to `fullscreenchange` than to poll.

import type { RefObject } from 'react';
import { useCallback, useEffect, useState } from 'react';

export interface UseFullscreenResult {
  isFullscreen: boolean;
  toggle: () => void;
}

export function useFullscreen(ref: RefObject<HTMLElement | null>): UseFullscreenResult {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggle = useCallback(() => {
    if (!document.fullscreenElement) {
      ref.current?.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  }, [ref]);

  return { isFullscreen, toggle };
}
