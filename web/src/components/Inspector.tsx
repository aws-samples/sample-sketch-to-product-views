import type { PipelineState } from '@sketch-to-product-views/contracts';
import { PROMPT_ID, type CanvasNodeId } from '../lib/flow-layout';
import { StageDetail } from './StageDetail';
import { PromptPanel } from './PromptPanel';
import { CandidatePanel } from './CandidatePanel';
import { ReviewGate } from './ReviewGate';

/**
 * The detail rail beside the canvas: what does not fit on a card. A selection adds its detail
 * at the top; it never hides the run-wide panels.
 */
export function Inspector({
  state,
  live,
  selected,
  replaying,
  frozenAt,
}: {
  /** The projected document: replayed while scrubbing, otherwise live. */
  state: PipelineState;
  /** The live document, the only one the review gate may act on. */
  live: PipelineState;
  selected: CanvasNodeId;
  replaying: boolean;
  frozenAt?: string;
}) {
  return (
    <aside className="inspector">
      {state.failureReason ? (
        <section className="card card--failed">
          <h3>Run failed</h3>
          <p>{state.failureReason}</p>
        </section>
      ) : null}

      {/* An action on the present: reads `live` and hides while replaying. Keyed per round. */}
      {!replaying && live.status === 'awaiting_review' ? (
        <ReviewGate key={live.regenerations?.length ?? 0} state={live} />
      ) : null}

      {selected === PROMPT_ID ? <PromptPanel state={state} /> : null}
      {selected && selected !== PROMPT_ID ? (
        <StageDetail state={state} stage={selected} frozenAt={frozenAt} />
      ) : null}

      <CandidatePanel state={state} />
    </aside>
  );
}
