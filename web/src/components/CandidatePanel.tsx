import {
  viewsToRemake,
  type AttributeResult,
  type Candidate,
  type CandidateView,
  type PipelineState,
  type SpecFieldKey,
} from '@sketch-to-product-views/contracts';
import { ZoomImage } from './ZoomImage';
import { ModelTag } from './ModelTag';
import { byAttempt, VIEW_LABELS, viewOf } from '../lib/views';
import { inputDescriptions, inputLabels } from '../lib/inputs';

/**
 * The inputs, the specification, and every generated view with the critic's verdict. Rejected
 * attempts stay on screen: why a view failed is what prompt tuning needs.
 */

const SPEC_LABELS: [SpecFieldKey, string][] = [
  ['productType', 'Product type'],
  ['materialDescription', 'Material'],
  ['colorDescription', 'Colour'],
  ['dimensions', 'Dimensions'],
];

const PART = 'part: ';

/** One mismatch with the critic's reason beside it. */
function Mismatch({ result, label }: { result: AttributeResult; label: string }) {
  return (
    <li>
      {label}: expected {result.expected}, saw {result.observed}
      {result.reason ? <span className="muted"> — {result.reason}</span> : null}
    </li>
  );
}

function Verdict({ candidate }: { candidate: Candidate }) {
  const evaluation = candidate.evaluation;
  if (!evaluation) return <p className="muted">Not scored.</p>;
  const { scores } = evaluation;
  const misses = evaluation.attributes?.filter((a) => a.outcome === 'mismatch') ?? [];
  const aspects = misses.filter((a) => !a.attribute.startsWith(PART));
  const parts = misses.filter((a) => a.attribute.startsWith(PART));
  return (
    <div className="verdict">
      <span className={`badge badge--${evaluation.verdict}`}>{evaluation.verdict}</span>
      {evaluation.model ? <ModelTag model={evaluation.model} role="Reviewed by" /> : null}
      <dl className="scores">
        <div>
          <dt>Sketch fidelity</dt>
          <dd>{scores.sketchFidelity.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Spec adherence</dt>
          <dd>{scores.specAdherence.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Image quality</dt>
          <dd>{scores.imageQuality.toFixed(2)}</dd>
        </div>
      </dl>
      {evaluation.issues.length > 0 ? (
        <ul className="issues">
          {evaluation.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {misses.length > 0 ? (
        <details className="io-earlier">
          <summary>
            {misses.length} mismatch{misses.length === 1 ? '' : 'es'}
          </summary>
          <ul className="issues">
            {aspects.map((a) => (
              <Mismatch key={a.attribute} result={a} label={a.attribute.replace(/_/g, ' ')} />
            ))}
            {parts.length > 0 ? (
              <li>
                Parts
                <ul>
                  {parts.map((a) => (
                    <Mismatch key={a.attribute} result={a} label={a.attribute.slice(PART.length)} />
                  ))}
                </ul>
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Specification({ state }: { state: PipelineState }) {
  const spec = state.spec;
  if (!spec) return null;
  return (
    <section className="card">
      <h3>Specification</h3>
      <dl className="spec">
        {SPEC_LABELS.map(([key, label]) => {
          const field = spec[key];
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {field ? (
                  <>
                    {field.value}
                    <span
                      className={`chip${field.provenance === 'observed' ? ' chip--observed' : ''}`}
                      title={field.raw ? `As read: ${field.raw}` : undefined}
                    >
                      {field.provenance}
                    </span>
                  </>
                ) : (
                  <span className="muted">unspecified</span>
                )}
              </dd>
            </div>
          );
        })}
        {spec.views ? (
          <div>
            <dt>Views drawn</dt>
            <dd>{spec.views.length > 0 ? spec.views.join(', ') : 'none'}</dd>
          </div>
        ) : null}
      </dl>
      {spec.parts?.length ? (
        <>
          <h4>Parts drawn</h4>
          <ul className="plain-list">
            {spec.parts.map((p) => (
              <li key={`${p.name}-${p.location}`}>
                <strong>{p.name}</strong>
                {p.description ? `: ${p.description}` : ''}{' '}
                {p.location ? <span className="muted">({p.location})</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {spec.details?.length ? (
        <>
          <h4>Details to keep</h4>
          <ul className="plain-list">
            {spec.details.map((d) => (
              <li key={`${d.view}-${d.location}-${d.description}`}>
                {d.description}{' '}
                <span className="muted">
                  ({d.view}, {d.location})
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {spec.ignored?.length ? (
        <p className="muted">Left out of the images: {spec.ignored.join('; ')}.</p>
      ) : null}
      {state.warning ? <p className="notice">{state.warning}</p> : null}
      {state.productMetadata ? (
        <details className="io-earlier">
          <summary>Product details, as submitted</summary>
          <pre className="io-json">{state.productMetadata.text}</pre>
        </details>
      ) : null}
    </section>
  );
}

/** The design team's notes and each regeneration a reviewer asked for. */
function Requests({ state }: { state: PipelineState }) {
  const rounds = state.regenerations ?? [];
  if (!state.guidance && rounds.length === 0) return null;
  return (
    <section className="card">
      <h3>Requests</h3>
      <div className="stack">
        {state.guidance ? (
          <article className="request">
            <strong>Design notes</strong>
            <p>{state.guidance.notes}</p>
            <RoutedTo views={state.guidance.views} />
          </article>
        ) : null}
        {rounds.map((r) => (
          <article key={r.round} className="request">
            <strong>
              Regeneration {r.round}
              {r.reviewedBy ? <span className="muted"> · {r.reviewedBy}</span> : null}
            </strong>
            <p>{r.notes}</p>
            <RoutedTo views={r.views} />
            <RemadeWith views={r.views} />
            {r.attributes?.length ? (
              <p className="muted">
                The critic checks {r.attributes.map((a) => a.replace(/_/g, ' ')).join(', ')} against
                the request, not the sketch.
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function RoutedTo({ views }: { views: { view: Candidate['view']; request: string }[] }) {
  if (views.length === 0) return null;
  return (
    <ul className="plain-list">
      {views.map((v) => (
        <li key={`${v.view}-${v.request}`}>
          <strong>{v.view}</strong>: {v.request}
        </li>
      ))}
    </ul>
  );
}

/** The views remade only because they are made from a changed one. */
function RemadeWith({ views }: { views: { view: CandidateView }[] }) {
  const asked = new Set(views.map((v) => v.view));
  const followed = viewsToRemake(asked).filter((view) => !asked.has(view));
  if (followed.length === 0) return null;
  return (
    <p className="muted">
      Also remade, as they are made from a changed view:{' '}
      {followed.map((view) => VIEW_LABELS[view].toLowerCase()).join(', ')}.
    </p>
  );
}

export function CandidatePanel({ state }: { state: PipelineState }) {
  const selected = new Set(Object.values(state.selectedViews ?? {}));
  const attempts = byAttempt(state.candidates);
  const outcome = state.criticOutcome;
  // What the analyser read each upload as, and its few words on it.
  const labels = inputLabels(state);
  const descriptions = inputDescriptions(state);

  return (
    <div className="stack">
      <section className="card">
        <h3>Inputs</h3>
        <div className="thumbs">
          {state.inputs.map((input, i) => (
            <figure key={input.key ?? input.filename} className="thumb" title={descriptions[i]}>
              <ZoomImage src={input.url} alt={labels[i]} />
              <figcaption>{labels[i]}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <Specification state={state} />
      <Requests state={state} />

      <section className="card">
        <h3>
          Generated views <span className="muted">({state.candidates.length})</span>
        </h3>
        {outcome && 'approved' in outcome && !outcome.approved ? (
          <p className="notice">
            The critic rejected all {outcome.attempts} attempts; attempt {outcome.attempt}, the
            best, went to review.
          </p>
        ) : null}
        {attempts.length === 0 ? (
          <p className="muted">No image yet.</p>
        ) : (
          [...attempts].reverse().map(([attempt, views]) => (
            <div key={attempt} className="attempt">
              <h4>Attempt {attempt}</h4>
              <div className="candidates">
                {views.map((candidate) => (
                  <article
                    key={candidate.id}
                    className={`candidate${selected.has(candidate.id) ? ' candidate--selected' : ''}`}
                  >
                    <ZoomImage
                      src={candidate.url}
                      alt={`${VIEW_LABELS[viewOf(candidate)]}, attempt ${attempt}`}
                    />
                    <header>
                      <strong>{VIEW_LABELS[viewOf(candidate)]}</strong>
                      <span className="muted">
                        {candidate.latencyMs ? `${(candidate.latencyMs / 1000).toFixed(1)}s` : ''}
                        {candidate.estimatedCostUsd
                          ? ` · $${candidate.estimatedCostUsd.toFixed(3)}`
                          : ''}
                      </span>
                    </header>
                    {/* Per image: an earlier attempt keeps naming the model it used. */}
                    {candidate.model ? (
                      <ModelTag model={candidate.model} role="Generated by" />
                    ) : (
                      <span className="muted">{candidate.modelId}</span>
                    )}
                    <Verdict candidate={candidate} />
                  </article>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
