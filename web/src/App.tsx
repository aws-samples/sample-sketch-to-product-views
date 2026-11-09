import { useEffect, useState } from 'react';
import { STAGES, type PipelineState } from '@sketch-to-product-views/contracts';
import { authEnabled, completeSignIn, signIn, signOut, signedIn } from './lib/auth';
import { SIGNED_OUT_EVENT } from './lib/api';
import { usePipeline } from './lib/usePipeline';
import { useRunNotifications } from './lib/useRunNotifications';
import { focusStage } from './lib/run-focus';
import { replayAt } from './lib/replay';
import { StartRun } from './components/StartRun';
import { Lightbox } from './components/Lightbox';
import { StageCanvas } from './components/StageCanvas';
import { Inspector } from './components/Inspector';
import { RunScrubber } from './components/RunScrubber';
import { EventLog } from './components/EventLog';
import { NotifyMe } from './components/NotifyMe';
import { Toasts } from './components/Toasts';
import type { CanvasNodeId } from './lib/flow-layout';

const STATUS_TEXT: Record<string, string> = {
  running: 'Running',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** A run lives at `#/r/{revisionId}`: shareable, and a reload lands back on it. */
function revisionFromHash(): string | null {
  const match = /^#\/r\/(.+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * `ready` gates every API call, `signedIn` drives the header, `error` surfaces a failed code
 * exchange. With auth disabled, `ready` is true at once.
 */
function useAuth(): { ready: boolean; signedIn: boolean; error: string | null } {
  const [isSignedIn, setSignedIn] = useState(signedIn);
  const [settled, setSettled] = useState(!authEnabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authEnabled) return;
    completeSignIn()
      .then((exchanged) => {
        if (exchanged) setSignedIn(true);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSettled(true));
  }, []);

  // A 401 from the API, not a timer, ends the session.
  useEffect(() => {
    const onSignedOut = () => {
      setSignedIn(false);
      setError('Your session expired. Sign in again to pick up where you left off.');
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  return { ready: settled && (!authEnabled || isSignedIn), signedIn: isSignedIn, error };
}

export default function App() {
  const [revisionId, setRevisionId] = useState<string | null>(revisionFromHash);
  const [selected, setSelected] = useState<CanvasNodeId>(null);
  /** Event the timeline is parked on, or `null` for live. */
  const [scrubSeq, setScrubSeq] = useState<number | null>(null);
  /** The detail rail; hiding it gives the canvas the whole width. */
  const [detailsOpen, setDetailsOpen] = useState(true);
  const auth = useAuth();
  const { state, error, missing } = usePipeline(auth.ready ? revisionId : null);
  // The live run only: a replay is the past.
  const { toasts, dismiss } = useRunNotifications(state);

  // A dead link says so, then returns to the start.
  useEffect(() => {
    if (!missing) return;
    const id = window.setTimeout(() => setRevisionId(null), 3000);
    return () => window.clearTimeout(id);
  }, [missing]);

  // The URL follows the state…
  useEffect(() => {
    const next = revisionId ? `#/r/${encodeURIComponent(revisionId)}` : '';
    if (revisionFromHash() !== revisionId) {
      window.history.replaceState(null, '', next || window.location.pathname);
    }
  }, [revisionId]);

  // …and the state follows the URL, so Back and a pasted link both land somewhere real.
  useEffect(() => {
    const onHashChange = () => setRevisionId(revisionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A failure selects itself: its events say why the run stopped.
  const failed = state?.status === 'failed' ? focusStage(state) : null;
  useEffect(() => {
    if (failed) setSelected(failed);
  }, [failed]);

  // Only the scrubber and the review gate read `state`; acting on a replay would approve the past.
  const view = state && scrubSeq !== null ? replayAt(state, scrubSeq) : state;
  const replaying = view !== state;
  const frozenAt = replaying ? view?.events.at(-1)?.at : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Sketch to product views</h1>
        </div>
        {state && view ? <RunSummary state={state} view={view} /> : null}
        <div className="topbar-actions">
          {state ? (
            <>
              <NotifyMe />
              <button className="btn btn--ghost" onClick={() => setDetailsOpen((open) => !open)}>
                {detailsOpen ? 'Hide details' : 'Show details'}
              </button>
              <button className="btn btn--ghost" onClick={() => setRevisionId(null)}>
                New run
              </button>
            </>
          ) : null}
          {authEnabled && auth.signedIn ? (
            <button className="btn btn--ghost" onClick={signOut}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {!auth.ready ? (
        <main className="single">
          <SignInGate error={auth.error} />
        </main>
      ) : missing ? (
        <main className="single">
          <section className="gate">
            <h2>That run is gone</h2>
            <p>Nothing is stored against this link any more. Taking you back to start a new run.</p>
          </section>
        </main>
      ) : !revisionId ? (
        <main className="single">
          <StartRun onStarted={setRevisionId} />
        </main>
      ) : (
        <main className={`workspace${detailsOpen ? '' : ' workspace--wide'}`}>
          {/* A failing poll, above everything it makes stale. */}
          {error ? <p className="error workspace-error">{error}</p> : null}
          {view && state ? (
            <>
              {/* One left-column element, so the rail's height cannot push the scrubber away. */}
              <div className="workspace-main">
                <StageCanvas
                  state={view}
                  selected={selected}
                  onSelect={setSelected}
                  frozenAt={frozenAt}
                />
                <RunScrubber state={state} seq={scrubSeq} onSeq={setScrubSeq} />
                <EventLog state={view} />
              </div>
              {detailsOpen ? (
                <Inspector
                  state={view}
                  live={state}
                  selected={selected}
                  replaying={replaying}
                  frozenAt={frozenAt}
                />
              ) : null}
            </>
          ) : (
            <p className="muted">Starting…</p>
          )}
        </main>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <Lightbox />
    </div>
  );
}

/** The topbar during a run, one fact per cell. */
function RunSummary({ state, view }: { state: PipelineState; view: PipelineState }) {
  // Identity from the live document, progress from the projection.
  const done = Object.values(view.stages).filter((s) => s.status === 'passed').length;

  return (
    <dl className="run-summary">
      <div>
        <dt>Product</dt>
        <dd>{state.productId}</dd>
      </div>
      <div>
        <dt>Revision</dt>
        <dd>{state.revision}</dd>
      </div>
      <div>
        <dt>Stages done</dt>
        <dd>
          {done} of {STAGES.length}
        </dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>
          <span className={`badge badge--${view.status}`}>{STATUS_TEXT[view.status]}</span>
        </dd>
      </div>
    </dl>
  );
}

function SignInGate({ error }: { error: string | null }) {
  return (
    <section className="gate">
      <h2>Turn a sketch into studio photographs</h2>
      <p>
        {error ??
          'Upload a sketch and the pipeline takes it from there: analysis, specification, four generated views, the critic, your review, delivery.'}
      </p>
      <button className="btn btn--primary" onClick={signIn}>
        Sign in
      </button>
    </section>
  );
}
