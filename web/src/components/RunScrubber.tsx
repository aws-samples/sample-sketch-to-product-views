import type { PipelineState } from '@sketch-to-product-views/contracts';
import { eventLabel } from './EventLog';
import { liveLabel } from '../lib/progress';

/**
 * A timeline over the event log: a finished run is a recording, and scrubbing back is how to
 * see a rejected attempt in context. Controlled; `seq === null` means live.
 */
export function RunScrubber({
  state,
  seq,
  onSeq,
}: {
  /** The live document, so the track spans the whole run while replaying. */
  state: PipelineState;
  seq: number | null;
  onSeq: (seq: number | null) => void;
}) {
  const events = state.events;
  if (events.length < 2) return null;

  const last = events[events.length - 1].seq;
  const value = seq ?? last;
  const at = events.find((e) => e.seq === value) ?? events[events.length - 1];
  const live = seq === null;

  return (
    <div className="scrubber">
      <input
        type="range"
        min={events[0].seq}
        max={last}
        value={value}
        // The end is live, so it hands control back.
        onChange={(e) => {
          const next = Number(e.target.value);
          onSeq(next >= last ? null : next);
        }}
        aria-label="Replay the run"
      />
      <p className="scrubber-caption muted">
        <span className={`badge badge--${live ? 'running' : 'warn'}`}>
          {live ? 'Live' : 'Replay'}
        </span>
        {/* Live: everything in progress. Replay: the event the track is parked on. */}
        <span className="scrubber-now" aria-live="polite">
          {live ? liveLabel(state) : `${eventLabel(at)} — ${at.status.replace('_', ' ')}`}
        </span>
        <span className="scrubber-count">
          event {value} of {last}
        </span>
        {live ? null : (
          <button type="button" className="btn btn--small" onClick={() => onSeq(null)}>
            Back to live
          </button>
        )}
      </p>
    </div>
  );
}
