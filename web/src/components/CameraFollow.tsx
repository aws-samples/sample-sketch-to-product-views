import { useEffect, useRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { StageId } from '@sketch-to-product-views/contracts';
import { centreOn } from '../lib/camera';

/**
 * Pans the camera to the stage the work is at, at the current zoom. Opt-out, and only moves for
 * a new stage, so it does not yank a viewer reading a finished one.
 */
export function CameraFollow({ target, enabled }: { target: StageId | null; enabled: boolean }) {
  const flow = useReactFlow();
  const last = useRef<StageId | null>(null);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  useEffect(() => {
    if (!enabled || !target || target === last.current) return;
    const node = flow.getNode(target);
    if (!node) return;
    last.current = target;
    const zoom = flow.getZoom();
    // Only along an axis the graph overflows: a graph fitted to the height stays level.
    const centre = centreOn(
      { x: node.position.x + (node.width ?? 0) / 2, y: node.position.y + (node.height ?? 0) / 2 },
      flow.getNodesBounds(flow.getNodes()),
      { width, height },
      zoom,
    );
    flow.setCenter(centre.x, centre.y, { zoom, duration: 600 });
  }, [enabled, target, flow, width, height]);

  // Re-arm on disable, so re-enabling recentres on the current stage.
  useEffect(() => {
    if (!enabled) last.current = null;
  }, [enabled]);

  return null;
}
