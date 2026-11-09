import { useEffect, useState } from 'react';
import { stageMeta, type PipelineState, type StageEvent, type StageId } from '@sketch-to-product-views/contracts';
import { StageIo } from './StageIo';
import { GenerationViews } from './GenerationViews';
import { generationProgress } from '../lib/progress';

/** What one stage did, filtered from the same event log the screen is projected from. */
export function StageDetail({
  state,
  stage,
  frozenAt,
}: {
  state: PipelineState;
  stage: StageId;
  /** Set while replaying. */
  frozenAt?: string;
}) {
  const meta = stageMeta(stage);
  const run = state.stages[stage];
  const events = state.events.filter((event) => event.stage === stage);
  const generation = stage === 'generate_2d' ? generationProgress(state) : null;

  // Counts up while running: tells "slow" from "stuck" between events.
  const running = Boolean(run?.startedAt) && !run?.endedAt;
  const elapsed = useElapsed(run?.startedAt, run?.endedAt, running);

  // The newest snapshot first; earlier ones one click away.
  const withDetail = events.filter((event) => event.detail);
  const newest = withDetail.at(-1);

  return (
    <section className="card">
      <h3>
        {meta.num} {meta.label}
      </h3>
      <p className="muted">
        {generation?.active ? 'running' : (run?.status ?? 'pending')}
        {elapsed ? ` · ${elapsed}` : ''}
        {run?.stubbed ? ' · stubbed' : ''}
      </p>
      {generation ? (
        <GenerationViews progress={generation} frozenAt={frozenAt} size="panel" />
      ) : run?.message ? (
        <p>{run.message}</p>
      ) : null}
      {events.length === 0 ? (
        <p className="muted">This stage has not run yet.</p>
      ) : (
        <ol className="log log--narrow">
          {events.map((event) => (
            <li key={event.seq} className={`log-row log-row--${event.status}`}>
              <span className="log-time">{new Date(event.at).toLocaleTimeString()}</span>
              <span className="log-status">{event.status}</span>
              <span className="log-message">
                {event.view ? <strong>{event.view} </strong> : null}
                {event.message}
              </span>
            </li>
          ))}
        </ol>
      )}

      {newest ? (
        <>
          <p className="muted io-note">{snapshotLabel(newest)}</p>
          <StageIo detail={newest.detail!} />
          {withDetail
            .slice(0, -1)
            .reverse()
            .map((event) => (
              <details key={event.seq} className="io-earlier">
                <summary>{snapshotLabel(event)}</summary>
                <StageIo detail={event.detail!} />
              </details>
            ))}
        </>
      ) : null}
    </section>
  );
}

function snapshotLabel(event: StageEvent): string {
  const parts = [
    event.attempt ? `Attempt ${event.attempt}` : undefined,
    event.view,
    event.status,
    new Date(event.at).toLocaleTimeString(),
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Formatted seconds, re-rendering only while the stage is open-ended. */
function useElapsed(
  startedAt: string | undefined,
  endedAt: string | undefined,
  running: boolean,
): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [running]);

  if (!startedAt) return null;
  const end = endedAt ? Date.parse(endedAt) : now;
  return `${((end - Date.parse(startedAt)) / 1000).toFixed(1)}s`;
}
