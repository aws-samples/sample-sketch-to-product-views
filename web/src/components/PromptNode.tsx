import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

/**
 * The prompt, between complete_spec and generate_2d. An artifact, not a stage: no number, no
 * status. The retry loop lands here because a rejected view changes its prompt and nothing
 * else. Every version, with diffs, is in the inspector.
 */

export interface PromptNodeData extends Record<string, unknown> {
  /** The latest prompt sent to the image model, if any. */
  text?: string;
  /** Attempts that were prompted. */
  attempts: number;
}

export type PromptNodeType = Node<PromptNodeData, 'prompt'>;

export function PromptNode({ data, selected }: NodeProps<PromptNodeType>) {
  return (
    <div className={`prompt-node${selected ? ' prompt-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="in-left" />
      {/* Bottom: the critic sits below and to the right, so the arc does not cross the node. */}
      <Handle type="target" position={Position.Bottom} id="retry-in" />

      <header className="prompt-node-head">
        <span>Prompt</span>
        {data.attempts > 1 ? <span className="chip">{data.attempts} attempts</span> : null}
      </header>

      {data.text ? (
        <p className="prompt-node-text">{data.text}</p>
      ) : (
        <p className="prompt-node-text muted">Built once the specification is complete.</p>
      )}

      <Handle type="source" position={Position.Right} id="out-right" />
    </div>
  );
}
