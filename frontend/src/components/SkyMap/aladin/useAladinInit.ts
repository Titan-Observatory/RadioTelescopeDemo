// `aladin-lite` is the largest dependency in the live bundle (~1.5 MB). It's
// only needed inside the SkyMap, which mounts after the queue page, so a
// dynamic import keeps it out of the initial paint and lets Rollup emit it as
// a separate chunk that loads on demand.
import type { AladinCatalog, AladinInstance, AladinStatic, GraphicOverlay } from 'aladin-lite';
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from 'react';

import { altAzToRaDec, isInsideTriangle, raDecToAltAz } from '../../../lib/astro';
import type { RaDecTarget, RoboClawTelemetry, TelescopeConfig } from '../../../types';
import { HYDROGEN_SURVEY_ID, type SurveyId } from '../spectrum/surveys';
import { DEFAULT_HORIZON_VIEW, initialHorizonRotationDeg } from './orientation';


const TARGET_CLICK_DRAG_TOLERANCE_PX = 6;


type HoverTooltip =
  | { kind: 'sun' | 'beam' | 'pending'; x: number; y: number; fwhm?: number }
  | null;


interface UseAladinInitOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  config: TelescopeConfig | null;
  configRef: RefObject<TelescopeConfig | null>;
  telemetryRef: RefObject<RoboClawTelemetry | null>;
  surveyRef: RefObject<SurveyId>;
  onTargetRef: RefObject<((az: number, alt: number) => void) | null>;
  onClearTargetRef: RefObject<(() => void) | null>;
  onNoticeRef: RefObject<((msg: string | null) => void) | null>;
  setReady: Dispatch<SetStateAction<boolean>>;
  setPending: Dispatch<SetStateAction<RaDecTarget | null>>;
  setHoverTooltip: Dispatch<SetStateAction<HoverTooltip>>;
}


/**
 * Initialise Aladin Lite, attach pointer/click handlers, create the four
 * graphic overlays + target catalog, and surface them as refs.
 *
 * Owns the local handler state (active pointer, drag rAF, click-suppression
 * timer). Returns the refs SkyMap reads later from other effects.
 */
export function useAladinInit(opts: UseAladinInitOptions) {
  const {
    containerRef,
    config,
    configRef,
    telemetryRef,
    surveyRef,
    onTargetRef,
    onClearTargetRef,
    onNoticeRef,
    setReady,
    setPending,
    setHoverTooltip,
  } = opts;

  const aladinRef = useRef<AladinInstance | null>(null);
  const beamOverlayRef = useRef<GraphicOverlay | null>(null);
  const limitOverlayRef = useRef<GraphicOverlay | null>(null);
  const pendingOverlayRef = useRef<GraphicOverlay | null>(null);
  const horizonOverlayRef = useRef<GraphicOverlay | null>(null);
  const targetCatalogRef = useRef<AladinCatalog | null>(null);
  // The lazy-loaded aladin-lite module. SkyMap reads this once `ready` flips
  // true to build shapes/sources without re-importing the module itself.
  const aladinModuleRef = useRef<AladinStatic | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || !config || initializedRef.current) return;
    initializedRef.current = true;
    const container = containerRef.current;
    let cancelled = false;
    let removeClickHandler: (() => void) | null = null;

    void import('aladin-lite').then(({ default: A }) => A.init.then(() => {
      if (cancelled || !container) return;
      aladinModuleRef.current = A;
      const initialDate = new Date();
      const initialTarget = altAzToRaDec(DEFAULT_HORIZON_VIEW, config, initialDate);
      const initialRotation = initialHorizonRotationDeg(initialTarget, config, initialDate);

      const aladin = A.aladin(container, {
        survey: 'CDS/P/HI4PI/NHI',
        fov: 80,
        target: `${initialTarget.ra_deg} ${initialTarget.dec_deg}`,
        cooFrame: 'equatorial',  // equatorial coords, view centred on NE horizon
        projection: 'STG',       // stereographic — natural perspective
        inertia: false,
        showCooGrid: false,      // we draw our own alt/az grid below for a horizon-aligned look
        showReticle: false,
        showZoomControl: false,
        showFov: false,
        showFullscreenControl: false,
        showLayersControl: false,
        showGotoControl: false,
        showStatusBar: false,
        showFrame: false,
        showCooLocation: false,
        showProjectionControl: false,
      });
      aladin.setRotation(initialRotation);

      // Keep the local zenith pinned to screen-up. The position-angle of
      // local-up depends on where the view is centred, so we recompute the
      // rotation whenever the centre moves. Two triggers:
      //   (1) An rAF loop driven by pointer-down → pointer-up. This is what
      //       makes drag smooth at any zoom: at wide FoVs each pixel of drag
      //       spans many degrees, so positionChanged alone fires too coarsely
      //       and the view visibly snaps between updates.
      //   (2) An event listener for everything else (wheel zoom, programmatic
      //       gotos) where there's no pointer drag in progress.
      let lastRotation = initialRotation;
      const applyHorizonRotation = (ra: number, dec: number) => {
        if (cancelled) return;
        const cfg = configRef.current;
        if (!cfg) return;
        if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;
        const rot = initialHorizonRotationDeg({ ra_deg: ra, dec_deg: dec }, cfg, new Date());
        const diff = Math.abs(((rot - lastRotation + 540) % 360) - 180);
        if (diff < 0.005) return;
        lastRotation = rot;
        aladin.setRotation(rot);
      };

      const getCenterRaDec = (): [number, number] | null => {
        // Read RA/Dec at the screen centre via pix2world — that always
        // reflects the live view, including mid-drag, whereas Aladin's
        // getRaDec()/getCenter() are not consistently available in v3.
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const v = aladin.pix2world(rect.width / 2, rect.height / 2);
        if (!Array.isArray(v) || v.length < 2) return null;
        if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
        return [v[0], v[1]];
      };

      let dragFrame = 0;
      const dragLoop = () => {
        dragFrame = 0;
        if (cancelled) return;
        const c = getCenterRaDec();
        if (c) applyHorizonRotation(c[0], c[1]);
        // Reschedule for next frame while still dragging.
        dragFrame = requestAnimationFrame(dragLoop);
      };
      const startDragLoop = () => { if (!dragFrame) dragFrame = requestAnimationFrame(dragLoop); };
      const stopDragLoop = () => { if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; } };

      // One-shot updates outside of drag (wheel zoom, programmatic gotos).
      aladin.on('positionChanged', (e: Record<string, unknown>) => {
        if (dragFrame) return; // drag loop is already updating every frame
        const ra = e.ra as number | undefined;
        const dec = e.dec as number | undefined;
        if (typeof ra === 'number' && typeof dec === 'number') {
          applyHorizonRotation(ra, dec);
        }
      });

      // Overlays — horizon drawn first so it sits under everything else
      const horizonOverlay = A.graphicOverlay({ color: 'rgba(255,126,89,0.7)', lineWidth: 2 });
      const beamOverlay    = A.graphicOverlay({ color: 'rgba(114,224,173,0.85)', lineWidth: 2 });
      const limitOverlay   = A.graphicOverlay({ color: 'rgba(255,126,89,0.85)', lineWidth: 2 });
      const pendingOverlay = A.graphicOverlay({ color: '#f3cc6b', lineWidth: 1.5 });
      aladin.addOverlay(horizonOverlay);
      aladin.addOverlay(limitOverlay);
      aladin.addOverlay(beamOverlay);
      aladin.addOverlay(pendingOverlay);


      const targetCatalog = A.catalog({
        name: 'Targets',
        color: '#f3cc6b',
        sourceSize: 10,
        shape: 'circle',
        displayLabel: true,
        labelColor: '#f3cc6b',
        labelFont: '11px "IBM Plex Sans", system-ui, sans-serif',
      });
      aladin.addCatalog(targetCatalog);

      aladinRef.current = aladin;
      beamOverlayRef.current    = beamOverlay;
      limitOverlayRef.current   = limitOverlay;
      pendingOverlayRef.current = pendingOverlay;
      horizonOverlayRef.current = horizonOverlay;
      targetCatalogRef.current  = targetCatalog;
      setReady(true);

      let activePointer: { id: number; x: number; y: number; dragged: boolean } | null = null;
      let suppressClickUntil = 0;
      const dragToleranceSq = TARGET_CLICK_DRAG_TOLERANCE_PX * TARGET_CLICK_DRAG_TOLERANCE_PX;

      const clearPendingTarget = () => {
        setPending(null);
        setHoverTooltip(null);
        onNoticeRef.current?.(null);
        onClearTargetRef.current?.();
      };

      const handleRightClick = (e: MouseEvent | PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        clearPendingTarget();
      };

      const handlePointerDown = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button === 2) {
          handleRightClick(e);
          return;
        }
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        activePointer = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
        startDragLoop();
      };

      const handleMouseDown = (e: MouseEvent) => {
        if (e.button === 2) handleRightClick(e);
      };

      const handlePointerMove = (e: PointerEvent) => {
        if (!activePointer || e.pointerId !== activePointer.id) return;
        const dx = e.clientX - activePointer.x;
        const dy = e.clientY - activePointer.y;
        if (dx * dx + dy * dy > dragToleranceSq) activePointer.dragged = true;
      };

      const handlePointerUp = (e: PointerEvent) => {
        if (!activePointer || e.pointerId !== activePointer.id) return;
        if (activePointer.dragged) suppressClickUntil = performance.now() + 500;
        activePointer = null;
        stopDragLoop();
      };

      const handlePointerCancel = (e: PointerEvent) => {
        if (!activePointer || e.pointerId !== activePointer.id) return;
        if (activePointer.dragged) suppressClickUntil = performance.now() + 500;
        activePointer = null;
        stopDragLoop();
      };

      // Click: pix2world returns [ra, dec] in equatorial mode, so use it directly.
      const handleClick = (e: MouseEvent) => {
        if (suppressClickUntil > 0) {
          const shouldSuppress = performance.now() <= suppressClickUntil;
          suppressClickUntil = 0;
          if (shouldSuppress) return;
        }

        // Non-hydrogen surveys are exploration-only — the telescope is a 21 cm
        // instrument and pointing at, say, an infrared source would just put
        // the beam somewhere meaningless. Drop the click silently rather than
        // setting a target the user can't actually observe.
        if (surveyRef.current !== HYDROGEN_SURVEY_ID) return;

        const rect = container.getBoundingClientRect();
        const coords = aladin.pix2world(e.clientX - rect.left, e.clientY - rect.top);
        if (!coords || coords.length !== 2 || !isFinite(coords[0]) || !isFinite(coords[1])) return;

        const ra_deg = coords[0];
        const dec_deg = coords[1];
        const currentConfig = configRef.current;
        if (!currentConfig) return;

        const altAz = raDecToAltAz(ra_deg, dec_deg, currentConfig, new Date());

        // No physical hardware to protect when disconnected — skip limit checks
        const isDisconnected = telemetryRef.current?.connection.mode === 'disconnected';
        if (!isDisconnected) {
          if (altAz.altitude_deg < 0) {
            onNoticeRef.current?.('Selected point is below the horizon.');
            return;
          }
          if (currentConfig.pointing_limit_altaz.length === 3 &&
              !isInsideTriangle(altAz, currentConfig.pointing_limit_altaz)) {
            clearPendingTarget();
            onNoticeRef.current?.('Selected target is outside configured pointing limits.');
            return;
          }
        }

        onNoticeRef.current?.(null);
        setPending({ ra_deg, dec_deg });
        onTargetRef.current?.(altAz.azimuth_deg, altAz.altitude_deg);
      };
      container.addEventListener('pointerdown', handlePointerDown, true);
      container.addEventListener('mousedown', handleMouseDown, true);
      container.addEventListener('contextmenu', handleRightClick, true);
      container.addEventListener('pointermove', handlePointerMove, true);
      container.addEventListener('pointerup', handlePointerUp, true);
      container.addEventListener('pointercancel', handlePointerCancel, true);
      container.addEventListener('click', handleClick);
      removeClickHandler = () => {
        container.removeEventListener('pointerdown', handlePointerDown, true);
        container.removeEventListener('mousedown', handleMouseDown, true);
        container.removeEventListener('contextmenu', handleRightClick, true);
        container.removeEventListener('pointermove', handlePointerMove, true);
        container.removeEventListener('pointerup', handlePointerUp, true);
        container.removeEventListener('pointercancel', handlePointerCancel, true);
        container.removeEventListener('click', handleClick);
      };
    }));

    return () => {
      cancelled = true;
      removeClickHandler?.();
    };
  }, [config]);

  return {
    aladinRef,
    aladinModuleRef,
    beamOverlayRef,
    limitOverlayRef,
    pendingOverlayRef,
    horizonOverlayRef,
    targetCatalogRef,
  };
}
