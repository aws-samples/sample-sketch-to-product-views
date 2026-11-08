import { STAGES, type PipelineState, type StageId } from '@sketch-to-product-views/contracts';

/**
 * The stage a viewer should look at now; the camera and the failure auto-select share it.
 * Live work outranks a failure (a rejected attempt is followed by its retry), a failure
 * outranks a finished stage.
 */
export function focusStage(state: PipelineState): StageId | null {
  const status = (id: StageId) => state.stages[id]?.status;

  const live = STAGES.find((s) => status(s.id) === 'running' || status(s.id) === 'awaiting_review');
  if (live) return live.id;

  const failed = STAGES.find((s) => status(s.id) === 'failed');
  if (failed) return failed.id;

  const done = [...STAGES].reverse().find((s) => status(s.id) === 'passed');
  return done?.id ?? null;
}
