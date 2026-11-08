import { useEffect, useState } from 'react';
import type { GenerationProgress, ViewProgress } from '../lib/progress';
import { VIEW_LABELS } from '../lib/views';
import { ZoomImage } from './ZoomImage';

/** The four views of the current attempt, each with its state. On the card and in the panel. */
export function GenerationViews({
  progress,
  frozenAt,
  size = 'card',
}: {
  progress: GenerationProgress;
  /** While replaying: elapsed time stops at the replayed event. */
  frozenAt?: string;
  size?: 'card' | 'panel';
}) {
  const now = useNow(progress.active && !frozenAt);
  const until = frozenAt ? Date.parse(frozenAt) : now;
  return (
    <div className={`gen gen--${size}`}>
      <p className="gen-label">{progress.label}</p>
      <div className="gen-views">
        {progress.views.map((v) => (
          <figure key={v.view} className={`gen-view gen-view--${v.state}`} data-view={v.view}>
            <div className="gen-view-img">
              {v.candidate ? (
                <ZoomImage src={v.candidate.url} alt={`${VIEW_LABELS[v.view]} view`} />
              ) : (
                <span className="gen-view-empty">
                  {v.state === 'generating' ? <span className="pulse" /> : null}
                  {/* Done before its image is recorded, which happens with the profiles. */}
                  {v.state === 'done' ? <span aria-hidden="true">✓</span> : null}
                </span>
              )}
            </div>
            <figcaption title={v.message}>
              <strong>{VIEW_LABELS[v.view]}</strong> {stateText(v, until, size)}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function stateText(v: ViewProgress, until: number, size: 'card' | 'panel'): string {
  const took = (end: number) => (v.startedAt ? seconds(end - Date.parse(v.startedAt)) : '');
  switch (v.state) {
    case 'generating':
      return `generating ${took(until)}`;
    case 'done':
      return size === 'panel' && v.endedAt ? `done in ${took(Date.parse(v.endedAt))}` : 'done';
    case 'failed':
      return 'failed';
    case 'kept':
      return v.candidate && size === 'panel' ? `kept from attempt ${v.candidate.attempt}` : 'kept';
    case 'skipped':
      return 'not made';
    default:
      return 'waiting';
  }
}

/** "8s", "1m 05s". */
function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The clock, ticking only while something is running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
