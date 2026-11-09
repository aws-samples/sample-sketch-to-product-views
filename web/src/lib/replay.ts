import { STAGE_IDS, type PipelineState, type StageId, type StageRun } from '@sketch-to-product-views/contracts';

/**
 * The run as it looked at event `seq`: truncate the append-only log and project it again.
 * Nothing extra is stored for this, so derived fields are gated on the event that produced them.
 */

function lastSeq(state: PipelineState): number {
  return state.events.length > 0 ? state.events[state.events.length - 1].seq : 0;
}

/** True once `stage` reached a terminal state within the truncated log. */
function settled(events: PipelineState['events'], stage: StageId): boolean {
  return events.some((e) => e.stage === stage && (e.status === 'passed' || e.status === 'failed'));
}

export function replayAt(state: PipelineState, seq: number): PipelineState {
  // Scrubbing to the end returns the live document, never a reconstruction.
  if (seq >= lastSeq(state)) return state;

  const events = state.events.filter((e) => e.seq <= seq);
  const cutoffAt = events.length > 0 ? events[events.length - 1].at : state.createdAt;

  // Last event per stage wins; a stage with no event has not started.
  const stages: Partial<Record<StageId, StageRun>> = {};
  for (const event of events) {
    const previous = stages[event.stage];
    stages[event.stage] = {
      status: event.status,
      attempt: event.attempt ?? previous?.attempt ?? 0,
      message: event.message,
      startedAt: previous?.startedAt ?? event.at,
      endedAt: event.status === 'running' ? undefined : event.at,
      stubbed: event.stubbed ?? previous?.stubbed,
    };
  }
  for (const id of STAGE_IDS) {
    stages[id] ??= { status: 'pending', attempt: 0 };
  }

  // A candidate exists once generated; its verdict once the critic scored its attempt.
  const candidates = state.candidates
    .filter((c) => c.createdAt <= cutoffAt)
    .map((c) => {
      const judged = events.some(
        (e) =>
          e.stage === 'evaluate_2d' &&
          e.attempt === c.attempt &&
          (e.status === 'passed' || e.status === 'failed'),
      );
      return judged ? c : { ...c, evaluation: undefined };
    });

  // The selection is written just before the review gate opens; a later round's is not shown.
  const known = new Set(candidates.map((c) => c.id));
  const reviewing =
    events.some((e) => e.stage === 'human_review') &&
    state.selectedCandidateId !== undefined &&
    known.has(state.selectedCandidateId);
  const reviewed = events.filter((e) => e.stage === 'human_review' && e.status === 'passed').length;
  const gateOpen = stages.human_review?.status === 'awaiting_review';
  const delivered = settled(events, 'deliver');

  // More events followed by construction, so the run was still going: never `failed` here.
  return {
    ...state,
    events,
    stages: stages as PipelineState['stages'],
    status: gateOpen ? 'awaiting_review' : 'running',
    failureReason: undefined,
    attempt: candidates.length > 0 ? Math.max(...candidates.map((c) => c.attempt)) : 0,
    candidates,
    analysis: settled(events, 'analyse') ? state.analysis : undefined,
    spec: settled(events, 'complete_spec') ? state.spec : undefined,
    warning: settled(events, 'complete_spec') ? state.warning : undefined,
    selectedCandidateId: reviewing ? state.selectedCandidateId : undefined,
    selectedViews: reviewing ? state.selectedViews : undefined,
    criticOutcome: reviewing ? state.criticOutcome : undefined,
    regenerations: state.regenerations?.slice(0, reviewed),
    deliveryUrl: delivered ? state.deliveryUrl : undefined,
    deliveryUrls: delivered ? state.deliveryUrls : undefined,
  };
}
