import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ZoomImage } from './ZoomImage';
import { ModelTag } from './ModelTag';
import type { CandidateView, Evaluation, ModelUse, StageStatus } from '@sketch-to-product-views/contracts';
import { NODE_H } from '../lib/flow-layout';
import type { GenerationProgress } from '../lib/progress';
import { GenerationViews } from './GenerationViews';

/**
 * One stage card, carrying the stage's output and not just its status.
 *
 * `data-stage` and `data-status` are stable hooks for end-to-end tests.
 */

const STATUS_LABEL: Record<StageStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  awaiting_review: 'Awaiting review',
  skipped: 'Skipped',
};

export interface NodeThumb {
  url: string;
  caption: string;
  /** The full label, when the caption is shortened to fit. */
  title?: string;
}

export interface NodeVerdict {
  view: CandidateView;
  verdict: Evaluation['verdict'];
}

export interface StageNodeData extends Record<string, unknown> {
  num: string;
  label: string;
  status: StageStatus;
  note?: string;
  attempt?: string;
  stubbed?: boolean;
  retrySource?: boolean;
  /** Inputs on upload, the latest image of each view on generate. */
  thumbs?: NodeThumb[];
  /** Spec values on complete_spec; `observed` ones were read from the images. */
  chips?: { text: string; observed: boolean }[];
  /** The critic's verdict per view. */
  verdicts?: NodeVerdict[];
  /** The model this stage called, as the run recorded it. */
  model?: ModelUse;
  /** Delivered views. */
  downloads?: { view: CandidateView; url: string }[];
  /** Per-view state of the current 2D attempt. */
  generation?: GenerationProgress;
  /** Set while replaying, so elapsed times stop there. */
  frozenAt?: string;
}

export type StageNodeType = Node<StageNodeData, 'stage'>;

/** Low on the card, so the retry arc leaves below the title. */
const RETRY_OFFSET = { top: '78%' };

const THUMB_H = 64;
const CHIPS_H = 66;
/** The attempt label and two rows of view tiles (`.gen--card`). */
const GENERATION_H = 164;

/** How tall this card needs to be. Each constant pairs with a rule in `index.css`. */
export function nodeHeight(data: StageNodeData): number {
  let extra = 0;
  if (data.thumbs?.length) extra += THUMB_H + 20;
  if (data.generation) extra += GENERATION_H;
  if (data.chips?.length) extra += CHIPS_H + 5;
  if (data.verdicts?.length) extra += 52;
  if (data.downloads?.length) extra += 36;
  if (data.model) extra += 22;
  if (data.note) extra += 22;
  return NODE_H + extra;
}

export function StageNode({ id, data, selected }: NodeProps<StageNodeType>) {
  return (
    <div
      className={`node node--${data.status}${selected ? ' node--selected' : ''}`}
      data-stage={id}
      data-status={data.status}
    >
      <Handle type="target" position={Position.Left} id="in-left" />
      <Handle type="target" position={Position.Top} id="in-top" />

      <header className="node-head">
        <span className="node-num">{data.num}</span>
        <span className="node-label">{data.label}</span>
      </header>

      <div className="node-status">
        {data.status === 'running' ? <span className="pulse" /> : null}
        <span>{STATUS_LABEL[data.status]}</span>
        {data.stubbed ? <span className="chip chip--stub">stub</span> : null}
        {data.attempt ? <span className="chip">{data.attempt}</span> : null}
      </div>

      {data.thumbs?.length ? (
        <div className="node-thumbs">
          {data.thumbs.map((thumb) => (
            <figure key={thumb.url + thumb.caption} title={thumb.title}>
              <ZoomImage src={thumb.url} alt={thumb.title ?? thumb.caption} />
              <figcaption>{thumb.caption}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {data.generation ? (
        <GenerationViews progress={data.generation} frozenAt={data.frozenAt} />
      ) : null}

      {data.chips?.length ? (
        <div className="node-chips">
          {data.chips.map((chip) => (
            <span
              key={chip.text}
              className={`chip${chip.observed ? ' chip--observed' : ''}`}
              title={chip.observed ? 'Observed in the images' : 'Supplied in the metadata'}
            >
              {chip.text}
            </span>
          ))}
        </div>
      ) : null}

      {data.verdicts?.length ? (
        <div className="node-verdicts">
          {data.verdicts.map((v) => (
            <span key={v.view} className={`badge badge--${v.verdict}`}>
              {v.view} {v.verdict}
            </span>
          ))}
        </div>
      ) : null}

      {data.model ? <ModelTag model={data.model} /> : null}

      {data.downloads?.length ? (
        <div className="node-downloads">
          {data.downloads.map((d) => (
            // `stopPropagation`, or the click also toggles the node's selection.
            <a
              key={d.view}
              className="btn btn--primary btn--small"
              href={d.url}
              download
              onClick={(e) => e.stopPropagation()}
            >
              {d.view}
            </a>
          ))}
        </div>
      ) : null}

      {/* One line, cut with an ellipsis; the title carries a long note. */}
      {data.note ? (
        <p className="node-note" title={data.note}>
          {data.note}
        </p>
      ) : null}

      <Handle type="source" position={Position.Right} id="out-right" />
      <Handle type="source" position={Position.Bottom} id="out-bottom" />
      {data.retrySource ? (
        <Handle type="source" position={Position.Left} id="retry-out" style={RETRY_OFFSET} />
      ) : null}
    </div>
  );
}
