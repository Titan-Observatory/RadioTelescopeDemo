import { useCallback, useEffect, useRef, useState } from 'react';

interface Star {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  twinkleSpeed: number | null;
}

interface StarsBackgroundProps {
  starDensity?: number;
  allStarsTwinkle?: boolean;
  twinkleProbability?: number;
  minTwinkleSpeed?: number;
  maxTwinkleSpeed?: number;
  className?: string;
}

export function StarsBackground({
  starDensity = 0.00015,
  allStarsTwinkle = true,
  twinkleProbability = 0.7,
  minTwinkleSpeed = 0.5,
  maxTwinkleSpeed = 1,
  className,
}: StarsBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stars, setStars] = useState<Star[]>([]);

  const generateStars = useCallback(
    (width: number, height: number): Star[] => {
      const numStars = Math.floor(width * height * starDensity);
      return Array.from({ length: numStars }, () => {
        const shouldTwinkle =
          allStarsTwinkle || Math.random() < twinkleProbability;
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          radius: Math.random() * 0.05 + 0.5,
          opacity: Math.random() * 0.5 + 0.5,
          twinkleSpeed: shouldTwinkle
            ? minTwinkleSpeed +
              Math.random() * (maxTwinkleSpeed - minTwinkleSpeed)
            : null,
        };
      });
    },
    [starDensity, allStarsTwinkle, twinkleProbability, minTwinkleSpeed, maxTwinkleSpeed],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const resize = () => {
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (width === 0 || height === 0) return;
      canvas.width = width;
      canvas.height = height;
      setStars(generateStars(width, height));
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [generateStars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frameId: number;
    let lastFrame = 0;
    const frameInterval = 1000 / 20;

    const render = () => {
      if (document.hidden) {
        frameId = requestAnimationFrame(render);
        return;
      }
      const now = performance.now();
      if (now - lastFrame < frameInterval) {
        frameId = requestAnimationFrame(render);
        return;
      }
      lastFrame = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const star of stars) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
        ctx.fill();

        if (star.twinkleSpeed !== null) {
          star.opacity =
            0.5 +
            Math.abs(Math.sin((Date.now() * 0.001) / star.twinkleSpeed) * 0.5);
        }
      }

      frameId = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(frameId);
  }, [stars]);

  return <canvas ref={canvasRef} className={className ?? 'stars-background'} />;
}
