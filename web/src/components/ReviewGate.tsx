import { useState } from 'react';
import { MAX_REGENERATIONS, sanitizeText, type PipelineState } from '@sketch-to-product-views/contracts';
import { submitReview } from '../lib/api';
import { clean, removedHint } from '../lib/clean';

/**
 * The human review gate. The pipeline is parked in a durable wait, so this is the only thing
 * that can advance the run: approve delivers the views, regenerate remakes the views the
 * notes concern.
 */
export function ReviewGate({ state }: { state: PipelineState }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on success; the gate unmounts once the next poll shows the run moving.
  const [sent, setSent] = useState(false);
  const [removed, setRemoved] = useState(0);
  // As the API keeps them; the API also screens them with the guardrail and may refuse them.
  const cleanNotes = sanitizeText(notes, { multiline: true });

  const used = state.regenerations?.length ?? 0;
  const left = MAX_REGENERATIONS - used;
  const outcome = state.criticOutcome;
  const rejected = outcome && 'approved' in outcome && !outcome.approved ? outcome.issues : [];

  const decide = async (decision: 'approve' | 'regenerate') => {
    setBusy(true);
    setError(null);
    try {
      await submitReview(state.revisionId, {
        decision,
        ...(state.selectedCandidateId ? { candidateId: state.selectedCandidateId } : {}),
        ...(cleanNotes ? { notes: cleanNotes } : {}),
      });
      setNotes('');
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card--gate">
      <h3>Human review</h3>
      <p className="muted">
        The pipeline is waiting. Approve delivers the selected views. Regenerate remakes the views
        your notes concern, and the views made from them.
      </p>
      {rejected.length > 0 ? (
        <div className="notice">
          <p>The critic still rejects these views:</p>
          <ul className="issues">
            {rejected.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => {
          const result = clean(notes, 'multiline');
          if (result.text !== notes) setNotes(result.text);
          setRemoved(result.removed);
        }}
        placeholder="What should change? Required to regenerate, e.g. “a darker wood on every view”."
        maxLength={4000}
        rows={3}
      />
      {removedHint(removed) ? <p className="hint">{removedHint(removed)}</p> : null}
      <div className="row">
        <button
          className="btn btn--primary"
          disabled={busy || sent}
          onClick={() => void decide('approve')}
        >
          Approve
        </button>
        <button
          className="btn"
          disabled={busy || sent || !cleanNotes || left <= 0}
          title={
            left <= 0 ? `This run has used its ${MAX_REGENERATIONS} regenerations.` : undefined
          }
          onClick={() => void decide('regenerate')}
        >
          Regenerate with notes
        </button>
        <span className="muted">
          {left > 0
            ? `${left} of ${MAX_REGENERATIONS} regenerations left`
            : 'No regenerations left'}
        </span>
      </div>
      {sent ? <p className="muted">Decision sent. Waiting for the pipeline…</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
