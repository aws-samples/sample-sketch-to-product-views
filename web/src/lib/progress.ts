import {
  CANDIDATE_VIEWS,
  STAGES,
  viewsToRemake,
  type Candidate,
  type CandidateView,
  type PipelineState,
  type StageEvent,
  type StageId,
} from '@sketch-to-product-views/contracts';
import { viewOf } from './views';

/**
 * What 2D generation is doing now, per view, derived from the event log and the candidates.
 *
 * Each view is its own call (front, then back, then left and right in parallel), so the stage's
 * own status says little: it reads as the last transition of whichever view moved last.
 */

/** `skipped`: planned but never started, because generation stopped first. */
export type ViewState = 'waiting' | 'generating' | 'done' | 'failed' | 'kept' | 'skipped';

export interface ViewProgress {
  view: CandidateView;
  state: ViewState;
  /** When the view's current call started (`generating`), or its last call (`done`, `failed`). */
  startedAt?: string;
  /** When it finished (`done`, `failed`). */
  endedAt?: string;
  /** The image: this attempt's once recorded, or the earlier one a `kept` view shows. */
  candidate?: Candidate;
  /** The failure, as the pipeline reported it. */
  message?: string;
}

export interface GenerationProgress {
  /** As on the events and candidates. */
  attempt: number;
  /** 1-based when a reviewer asked for this attempt. */
  regeneration?: number;
  /** "Attempt 1 of 2" or "Regeneration 1". */
  label: string;
  /** Always the four views, in view order. */
  views: ViewProgress[];
  /** Some view is generating right now. */
  active: boolean;
}

const at = (event: StageEvent) => Date.parse(event.at);

/** Generation order: the back is made from the front, the profiles (together) from both. */
const RANK: Record<CandidateView, number> = { front: 0, back: 1, left: 2, right: 2 };

/** The current (last) attempt of 2D generation, or `null` before it started. */
export function generationProgress(state: PipelineState): GenerationProgress | null {
  const { events } = state;
  const lastGen = findLastIndex(
    events,
    (e) => e.stage === 'generate_2d' && e.attempt !== undefined,
  );
  if (lastGen < 0) return null;
  const attempt = events[lastGen].attempt!;

  // A review gate opens each round: attempts after one are regenerations. A gate re-announced
  // with no generation since (a retried emit) is the same gate.
  let round = 0;
  let roundStart = -1;
  let sinceGen = true;
  for (let i = 0; i < lastGen; i += 1) {
    const e = events[i];
    if (e.stage === 'generate_2d') sinceGen = true;
    if (e.stage === 'human_review' && e.status === 'awaiting_review') {
      if (sinceGen) round += 1;
      sinceGen = false;
      roundStart = i;
    }
  }

  // Attempt numbers can repeat across rounds, so only this round's events count.
  const ofAttempt = events
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => i > roundStart && e.stage === 'generate_2d' && e.attempt === attempt);
  const first = ofAttempt[0];
  const startedAt = at(first.e);
  const over =
    state.status !== 'running' || events.some((e, i) => i > first.i && e.stage !== 'generate_2d');

  const made = (c: Candidate) => !(Date.parse(c.createdAt) < startedAt);
  const current = (view: CandidateView) =>
    findLast(state.candidates, (c) => c.attempt === attempt && viewOf(c) === view && made(c));
  // The views the attempt starts from: the reviewed ones for a regeneration, else the newest.
  const selected = new Set(Object.values(state.selectedViews ?? {}));
  const earlier = (view: CandidateView) => {
    const before = state.candidates.filter((c) => viewOf(c) === view && !made(c));
    return (round > 0 ? findLast(before, (c) => selected.has(c.id)) : undefined) ?? before.at(-1);
  };

  const planned = plan(state, attempt, round, earlier);
  const views = CANDIDATE_VIEWS.map((view): ViewProgress => {
    const own = ofAttempt.filter(({ e }) => e.view === view).map(({ e }) => e);
    const last = own.at(-1);
    if (last) {
      const running = findLast(own, (e) => e.status === 'running');
      const base = { view, startedAt: running?.at ?? last.at };
      if (last.status === 'running') return { ...base, state: 'generating' };
      if (last.status === 'failed') {
        return { ...base, state: 'failed', endedAt: last.at, message: last.message };
      }
      return { ...base, state: 'done', endedAt: last.at, candidate: current(view) };
    }
    const kept = earlier(view);
    // Unplanned: a view is kept once a view made after it has started.
    const later = ofAttempt.some(({ e }) => e.view && RANK[e.view] > RANK[view]);
    const keep = planned ? !planned.has(view) : over || later;
    if (keep && kept) return { view, state: 'kept', candidate: kept };
    return { view, state: over ? 'skipped' : 'waiting' };
  });

  return {
    attempt,
    ...(round > 0 ? { regeneration: round } : {}),
    label: round > 0 ? `Regeneration ${round}` : `Attempt ${attempt} of ${state.attemptBudget}`,
    views,
    active: views.some((v) => v.state === 'generating'),
  };
}

/**
 * The views this attempt remakes, as the pipeline decides them: all four first, then the
 * rejected ones (and the views made from them), or what a regeneration asks for. `undefined`
 * when the run does not say.
 */
function plan(
  state: PipelineState,
  attempt: number,
  round: number,
  earlier: (view: CandidateView) => Candidate | undefined,
): Set<CandidateView> | undefined {
  if (round > 0) {
    const asked = state.regenerations?.[round - 1]?.views.map((v) => v.view);
    return asked ? new Set(viewsToRemake(asked)) : undefined;
  }
  if (attempt === 1) return new Set(CANDIDATE_VIEWS);
  const before = CANDIDATE_VIEWS.map(earlier);
  if (before.some((c) => !c?.evaluation)) return undefined;
  const failed = CANDIDATE_VIEWS.filter((_, i) => before[i]!.evaluation!.verdict === 'fail');
  return new Set(viewsToRemake(failed));
}

/** "left", "left and right", "front, back and left". */
export function joinViews(views: readonly CandidateView[]): string {
  if (views.length <= 1) return views[0] ?? '';
  return `${views.slice(0, -1).join(', ')} and ${views.at(-1)}`;
}

const STAGE_DOING: Partial<Record<StageId, string>> = {
  upload: 'Uploading the inputs',
  submit: 'Submitting the package',
  validate: 'Validating the package',
  analyse: 'Analysing the images',
  complete_spec: 'Building the specification',
  human_review: 'Reading the review notes',
  deliver: 'Delivering the approved views',
};

/** One line naming everything in progress, for under the scrubber. */
export function liveLabel(state: PipelineState): string {
  switch (state.status) {
    case 'awaiting_review':
      return 'Waiting for your review';
    case 'approved':
      return 'Approved: the views are delivered';
    case 'failed':
      return state.failureReason ? `Failed: ${state.failureReason}` : 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }

  const progress = generationProgress(state);
  const attemptOf = progress ? ` (${lowerFirst(progress.label)})` : '';
  const generating = progress?.views.filter((v) => v.state === 'generating').map((v) => v.view);
  if (generating?.length) {
    const what = generating.length === 1 ? `the ${generating[0]}` : joinViews(generating);
    return `Generating ${what}${attemptOf}`;
  }

  // The latest stage still running; generation in between two views reads as generating.
  const running = [...STAGES].reverse().find((s) => state.stages[s.id]?.status === 'running');
  if (running?.id === 'generate_2d') return `Generating the views${attemptOf}`;
  if (running?.id === 'evaluate_2d') return `Scoring the views${attemptOf}`;
  if (running) return STAGE_DOING[running.id] ?? running.label;
  return 'Working';
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function findLastIndex<T>(list: readonly T[], match: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i])) return i;
  return -1;
}

function findLast<T>(list: readonly T[], match: (item: T) => boolean): T | undefined {
  const i = findLastIndex(list, match);
  return i < 0 ? undefined : list[i];
}
