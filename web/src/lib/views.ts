import { CANDIDATE_VIEWS, type Candidate, type CandidateView } from '@sketch-to-product-views/contracts';

/** A candidate written before views existed is a front. */
export const viewOf = (c: Candidate): CandidateView => c.view ?? 'front';

/** The newest candidate of each view, in view order: what the run currently shows. */
export function latestViews(candidates: readonly Candidate[]): Candidate[] {
  return CANDIDATE_VIEWS.flatMap((view) => {
    const ofView = candidates.filter((c) => viewOf(c) === view);
    return ofView.length > 0 ? [ofView[ofView.length - 1]] : [];
  });
}

/** Candidates grouped by attempt, oldest first, each in view order. */
export function byAttempt(candidates: readonly Candidate[]): [number, Candidate[]][] {
  const groups = new Map<number, Candidate[]>();
  for (const c of candidates) groups.set(c.attempt, [...(groups.get(c.attempt) ?? []), c]);
  const order = (c: Candidate) => CANDIDATE_VIEWS.indexOf(viewOf(c));
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempt, list]) => [attempt, [...list].sort((a, b) => order(a) - order(b))]);
}

export const VIEW_LABELS: Record<CandidateView, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
};
