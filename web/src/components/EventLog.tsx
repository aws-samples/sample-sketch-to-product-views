import { useMemo, useState } from 'react';
import { stageMeta, type PipelineState, type StageEvent } from '@sketch-to-product-views/contracts';

/** "06 Generate 2D image · back", for a per-view event. */
export function eventLabel(event: StageEvent): string {
  const meta = stageMeta(event.stage);
  return `${meta.num} ${meta.label}${event.view ? ` · ${event.view}` : ''}`;
}

/**
 * The raw append-only event log everything else is projected from. Under the canvas, next to
 * the scrubber that moves along it; closed by default.
 */
export function EventLog({ state }: { state: PipelineState }) {
  const [open, setOpen] = useState(false);
  const events = useMemo(() => [...state.events].reverse(), [state.events]);

  return (
    <section className={`eventlog${open ? ' eventlog--open' : ''}`}>
      <button
        type="button"
        className="eventlog__toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="eventlog__caret" aria-hidden="true" />
        Event log
        <span className="muted">
          {state.events.length} event{state.events.length === 1 ? '' : 's'}
        </span>
      </button>

      {open ? (
        <ol className="log log--wide">
          {events.map((event) => (
            <li key={event.seq} className={`log-row log-row--${event.status}`}>
              <span className="log-time">{new Date(event.at).toLocaleTimeString()}</span>
              <span className="log-stage">{eventLabel(event)}</span>
              <span className="log-status">{event.status}</span>
              <span className="log-message">{event.message}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
