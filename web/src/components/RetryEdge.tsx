import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

/**
 * The critic → prompt retry loop. A forced arc into the gutter: a default bezier between two
 * left-facing handles with no horizontal gap collapses into a near-vertical line.
 */

/** Horizontal bulge; stays inside the inter-column gap. */
const BULGE = 72;

export function RetryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const path = `M ${sourceX},${sourceY} C ${sourceX - BULGE},${sourceY} ${targetX - BULGE},${targetY} ${targetX},${targetY}`;
  const labelX = Math.min(sourceX, targetX) - BULGE * 0.72;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <span
          // Portalled out of the edge's group, so "taken" arrives through `data`.
          className={`edge-label${data?.taken ? ' edge-label--taken' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
