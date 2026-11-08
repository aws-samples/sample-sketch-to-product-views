import type { Rect } from '@xyflow/react';

/** Space kept around a fitted graph, in React Flow's `padding` sense. */
export const FIT_PADDING = 0.06;
/** Matches `maxZoom` on the canvas: past this the cards are blown up, not clearer. */
export const MAX_ZOOM = 1.6;

/** The room the graph gets along a pane side of `size` once the padding is taken. */
export function fitRoom(size: number): number {
  return size / (1 + FIT_PADDING);
}

/** The zoom at which the whole graph fits the pane's height. */
export function heightFitZoom(bounds: Rect, paneHeight: number): number {
  return Math.min(fitRoom(paneHeight) / bounds.height, MAX_ZOOM);
}

/**
 * Where to centre the camera to look at `target` at `zoom`, per axis: the graph's centre when
 * the graph fits that axis, otherwise the target, clamped so the view never leaves the graph.
 */
export function centreOn(
  target: { x: number; y: number },
  bounds: Rect,
  pane: { width: number; height: number },
  zoom: number,
): { x: number; y: number } {
  const axis = (at: number, start: number, size: number, visible: number) => {
    const half = visible / zoom / 2;
    if (size <= 2 * half) return start + size / 2;
    return Math.min(Math.max(at, start + half), start + size - half);
  };
  return {
    x: axis(target.x, bounds.x, bounds.width, pane.width),
    y: axis(target.y, bounds.y, bounds.height, pane.height),
  };
}
