import { useEffect, useRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { StageId } from '@sketch-to-product-views/contracts';
import { centreOn, FIT_PADDING, fitRoom, heightFitZoom } from '../lib/camera';

/**
 * Frames the graph to the pane's height when the pane or the graph changes height, so the cards
 * grow with the screen. A graph then wider than the pane is centred on `focus` (or where the
 * camera already was); the Controls fit button still shows all of it.
 */
export function FitOnResize({ focus }: { focus: StageId | null }) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // Cards grow as outputs arrive; a taller graph needs a new zoom.
  const graphHeight = useStore((s) => {
    if (s.nodes.length === 0) return 0;
    const tops = s.nodes.map((n) => n.position.y);
    const bottoms = s.nodes.map((n) => n.position.y + (n.height ?? 0));
    return Math.round(Math.max(...bottoms) - Math.min(...tops));
  });
  // A ref: a new focus is CameraFollow's to act on.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const framed = useRef(false);

  useEffect(() => {
    if (!width || !height || !graphHeight) return;
    // The first framing is instant, or every page load would animate a zoom.
    const duration = framed.current ? 300 : 0;
    framed.current = true;

    const bounds = flow.getNodesBounds(flow.getNodes());
    const zoom = heightFitZoom(bounds, height);
    if (bounds.width * zoom <= fitRoom(width)) {
      void flow.fitView({ padding: FIT_PADDING, duration });
      return;
    }

    const node = focusRef.current ? flow.getNode(focusRef.current) : undefined;
    const view = flow.getViewport();
    const target = node
      ? { x: node.position.x + (node.width ?? 0) / 2, y: 0 }
      : { x: (width / 2 - view.x) / view.zoom, y: 0 };
    const centre = centreOn(target, bounds, { width, height }, zoom);
    void flow.setCenter(centre.x, centre.y, { zoom, duration });
  }, [width, height, graphHeight, flow]);

  return null;
}
