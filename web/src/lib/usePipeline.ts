import { useEffect, useRef, useState } from 'react';
import type { PipelineState } from '@sketch-to-product-views/contracts';
import { ApiError, getPipeline } from './api';

const TERMINAL: ReadonlySet<PipelineState['status']> = new Set(['approved', 'failed', 'cancelled']);

const POLL_MS = 1000;
/** Past this a run is usually parked at the review gate, so poll less often. */
const SLOW_AFTER_MS = 120_000;
const SLOW_POLL_MS = 5000;

/**
 * Polls one revision until it is terminal. Conditional GETs make idle polling a 304; a socket
 * would buy nothing for a handful of events over minutes.
 */
export function usePipeline(revisionId: string | null): {
  state: PipelineState | null;
  error: string | null;
  /** The backend has no such revision: a dead link, not an error. */
  missing: boolean;
} {
  const [state, setState] = useState<PipelineState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const etag = useRef<string | undefined>(undefined);

  useEffect(() => {
    setState(null);
    setError(null);
    setMissing(false);
    etag.current = undefined;
    if (!revisionId) return;

    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const result = await getPipeline(revisionId, etag.current, controller.signal);
        if (cancelled) return;
        if (result) {
          etag.current = result.etag ?? undefined;
          setState(result.state);
          setError(null);
          if (TERMINAL.has(result.state.status)) return;
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setMissing(true);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        // A 401/403 will not fix itself; anything else may be a blip, so keep polling.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
      }
      const elapsed = Date.now() - startedAt;
      timer = window.setTimeout(tick, elapsed > SLOW_AFTER_MS ? SLOW_POLL_MS : POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [revisionId]);

  return { state, error, missing };
}
