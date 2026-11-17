// Types for page-probes.mjs (in-page probes; see that file).
export type LiveEvent = {
  t: number;
  kind: "added" | "changed";
  politeness: string;
  atomic?: string;
  region: { tag: string; role?: string; id?: string; cls?: string; label?: string };
  text: string;
  hidden: boolean;
};
export type Geometry = {
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
    visualViewport: { width: number; height: number; scale: number } | null;
  };
  pointer: { coarse: boolean; fine: boolean; anyHover: boolean };
  colorScheme: { dark: boolean; dataTheme: string | null; reducedMotion: boolean };
  document: { scrollWidth: number; scrollHeight: number; clientWidth: number };
  horizontalOverflowPx: number;
  controlsOutsideViewport: {
    name: string;
    path: string;
    left: number;
    right: number;
    width: number;
    canvas: boolean;
    inScroller: string | null;
    whollyOutside: boolean;
  }[];
  canvasControlsOutsideViewport: number;
  clippedText: { text: string; path: string; scrollWidth: number; clientWidth: number; ellipsis: boolean }[];
};
export function liveRegionRecorder(): void;
export function pageGeometry(): Geometry;
