import type { Node, NodeProps } from '@xyflow/react';

/**
 * The labelled rectangle behind a column. A node, so it pans and zooms with the graph; inert
 * (`pointer-events: none`), so a click reaches the pane and clears the selection.
 */

export interface BandNodeData extends Record<string, unknown> {
  label: string;
}

export type BandNodeType = Node<BandNodeData, 'band'>;

export function BandNode({ data }: NodeProps<BandNodeType>) {
  return (
    <div className="band">
      <span className="band-label">{data.label}</span>
    </div>
  );
}
