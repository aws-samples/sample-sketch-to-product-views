import { useState } from 'react';
import { CANDIDATE_VIEWS, type CandidateView, type PipelineState } from '@sketch-to-product-views/contracts';
import { diffPrompts } from '../lib/prompt-diff';
import { VIEW_LABELS, viewOf } from '../lib/views';

/**
 * The exact prompt each image was generated from, as recorded on the candidate. Per view, since
 * each view is its own call; `Changes` diffs each attempt against the previous one of the view.
 */
export function PromptPanel({ state }: { state: PipelineState }) {
  const [showDiff, setShowDiff] = useState(true);
  const [picked, setPicked] = useState<CandidateView>('front');
  const prompted = state.candidates.filter((c) => c.prompt);

  if (prompted.length === 0) {
    return (
      <section className="card">
        <h3>Prompt</h3>
        <p className="muted">
          {state.spec
            ? 'Built from the specification; no image generated yet.'
            : 'The specification is not complete yet.'}
        </p>
      </section>
    );
  }

  const views = CANDIDATE_VIEWS.filter((v) => prompted.some((c) => viewOf(c) === v));
  const view = views.includes(picked) ? picked : views[0];
  const ofView = prompted.filter((c) => viewOf(c) === view);
  const multiple = ofView.length > 1;

  return (
    <section className="card">
      <h3>
        Prompt <span className="muted">({ofView.length})</span>
        {multiple ? (
          <span className="toggle">
            <button
              className={`toggle-btn${showDiff ? '' : ' toggle-btn--on'}`}
              onClick={() => setShowDiff(false)}
            >
              Full
            </button>
            <button
              className={`toggle-btn${showDiff ? ' toggle-btn--on' : ''}`}
              onClick={() => setShowDiff(true)}
            >
              Changes
            </button>
          </span>
        ) : null}
      </h3>

      {views.length > 1 ? (
        <div className="toggle toggle--views" role="tablist" aria-label="View">
          {views.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={v === view}
              className={`toggle-btn${v === view ? ' toggle-btn--on' : ''}`}
              onClick={() => setPicked(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="stack">
        {ofView.map((candidate, index) => {
          const previous = index > 0 ? ofView[index - 1].prompt : undefined;
          const prompt = candidate.prompt!;
          return (
            <article key={candidate.id} className="prompt">
              <header>
                <strong>
                  {VIEW_LABELS[view]}, attempt {candidate.attempt}
                </strong>
                <span className="muted">{candidate.model?.name ?? candidate.modelId}</span>
                <button
                  className="btn btn--ghost btn--small"
                  // A denied clipboard is not worth a message, nor an unhandled rejection.
                  onClick={() => void navigator.clipboard?.writeText(prompt).catch(() => {})}
                >
                  Copy
                </button>
              </header>
              <p className="prompt-text">
                {showDiff && previous
                  ? diffPrompts(previous, prompt).map((token, i) => (
                      <span key={i} className={`tok tok--${token.kind}`}>
                        {token.text}{' '}
                      </span>
                    ))
                  : prompt}
              </p>
              {showDiff && previous ? (
                <p className="muted prompt-legend">
                  vs attempt {ofView[index - 1].attempt}:{' '}
                  <span className="tok tok--removed">removed</span>{' '}
                  <span className="tok tok--added">added</span>
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
