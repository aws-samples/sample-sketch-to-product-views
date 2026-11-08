import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Candidate,
  CandidateView,
  PipelineState,
  StageEvent,
  StageRun,
} from '@sketch-to-product-views/contracts';
import { generationProgress, joinViews, liveLabel } from '../src/lib/progress.js';

/** A run built event by event; `t` is seconds from the start. */
function run() {
  const events: StageEvent[] = [];
  const candidates: Candidate[] = [];
  const time = (t: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, t)).toISOString();
  const api = {
    event(stage: StageEvent['stage'], status: StageEvent['status'], t: number, extra = {}) {
      events.push({
        seq: events.length + 1,
        revisionId: 'r',
        stage,
        status,
        at: time(t),
        ...extra,
      });
      return api;
    },
    gen(status: StageEvent['status'], view: CandidateView, attempt: number, t: number) {
      return api.event('generate_2d', status, t, { view, attempt });
    },
    candidate(view: CandidateView, attempt: number, t: number, verdict?: 'pass' | 'fail') {
      candidates.push({
        id: `${view}-${attempt}-${t}`,
        url: `https://x/${view}-${attempt}`,
        modelId: 'm',
        attempt,
        createdAt: time(t),
        view,
        ...(verdict
          ? {
              evaluation: {
                verdict,
                scores: { sketchFidelity: 1, specAdherence: 1, imageQuality: 1 },
                issues: [],
                reviewer: 'r',
              },
            }
          : {}),
      });
      return api;
    },
    state(extra: Partial<PipelineState> = {}): PipelineState {
      const stages: Partial<Record<StageEvent['stage'], StageRun>> = {};
      for (const e of events) stages[e.stage] = { status: e.status, attempt: e.attempt ?? 0 };
      return {
        revisionId: 'r',
        productId: 'p',
        revision: 1,
        status: 'running',
        createdAt: time(0),
        updatedAt: time(0),
        modelId: 'm',
        attemptBudget: 2,
        attempt: 1,
        inputs: [],
        stages,
        candidates: [...candidates],
        events: [...events],
        ...extra,
      };
    },
  };
  return api;
}

const states = (p: ReturnType<typeof generationProgress>) =>
  Object.fromEntries(p!.views.map((v) => [v.view, v.state]));

/** Attempt 1 up to the two profiles running together. */
const profilesRunning = () =>
  run()
    .event('complete_spec', 'passed', 1)
    .gen('running', 'front', 1, 2)
    .candidate('front', 1, 20)
    .gen('passed', 'front', 1, 20)
    .gen('running', 'back', 1, 21)
    .gen('passed', 'back', 1, 40)
    .gen('running', 'left', 1, 41)
    .gen('running', 'right', 1, 41);

test('nothing to show before generation starts', () => {
  assert.equal(generationProgress(run().event('analyse', 'running', 1).state()), null);
});

test('the profiles generating together both read as generating, the others done', () => {
  const state = profilesRunning().state();
  const p = generationProgress(state)!;
  assert.equal(p.label, 'Attempt 1 of 2');
  assert.deepEqual(states(p), {
    front: 'done',
    back: 'done',
    left: 'generating',
    right: 'generating',
  });
  assert.equal(p.views[0].candidate?.id, 'front-1-20', 'the front is recorded at once');
  assert.equal(p.views[1].candidate, undefined, 'the back is recorded with the profiles');
  assert.equal(p.views[2].startedAt, state.events.at(-1)!.at);
  assert.ok(p.active);
  assert.equal(liveLabel(state), 'Generating left and right (attempt 1 of 2)');
});

test('one profile done leaves the other generating, whatever the stage status says', () => {
  const state = profilesRunning().gen('passed', 'left', 1, 60).state();
  assert.equal(state.stages.generate_2d?.status, 'passed');
  assert.deepEqual(states(generationProgress(state)), {
    front: 'done',
    back: 'done',
    left: 'done',
    right: 'generating',
  });
  assert.equal(liveLabel(state), 'Generating the right (attempt 1 of 2)');
});

test('views not yet started wait', () => {
  const state = run().gen('running', 'front', 1, 2).state();
  assert.deepEqual(states(generationProgress(state)), {
    front: 'generating',
    back: 'waiting',
    left: 'waiting',
    right: 'waiting',
  });
});

test('a retry keeps the views the critic passed and remakes the rejected one', () => {
  const r = profilesRunning()
    .gen('passed', 'left', 1, 60)
    .gen('passed', 'right', 1, 61)
    .candidate('back', 1, 40, 'pass')
    .candidate('left', 1, 60, 'fail')
    .candidate('right', 1, 61, 'pass')
    .event('evaluate_2d', 'running', 62, { attempt: 1 })
    .event('evaluate_2d', 'passed', 70, { attempt: 1 });
  const base = r.state();
  // The front's verdict, written by the critic onto the attempt-1 front.
  base.candidates[0] = { ...base.candidates[0], evaluation: base.candidates[1].evaluation };
  const scoring = { ...base, stages: { evaluate_2d: { status: 'running' as const, attempt: 1 } } };
  assert.equal(liveLabel(scoring), 'Scoring the views (attempt 1 of 2)');

  r.gen('running', 'left', 2, 71);
  const state = { ...r.state(), candidates: base.candidates };
  const p = generationProgress(state)!;
  assert.equal(p.label, 'Attempt 2 of 2');
  assert.deepEqual(states(p), { front: 'kept', back: 'kept', left: 'generating', right: 'kept' });
  assert.equal(p.views[0].candidate?.id, 'front-1-20');
  assert.equal(liveLabel(state), 'Generating the left (attempt 2 of 2)');
});

test('a regeneration is named by its round, and keeps the views it does not ask for', () => {
  const r = profilesRunning()
    .gen('passed', 'left', 1, 60)
    .gen('passed', 'right', 1, 61)
    .candidate('back', 1, 40, 'pass')
    .candidate('left', 1, 60, 'pass')
    .candidate('right', 1, 61, 'pass')
    .event('evaluate_2d', 'passed', 70, { attempt: 1 })
    .event('human_review', 'awaiting_review', 71)
    .event('human_review', 'passed', 80)
    .event('human_review', 'running', 81)
    .event('human_review', 'passed', 85)
    // The attempt number of a regeneration can repeat an earlier one.
    .gen('running', 'right', 1, 86);
  const state = r.state({
    regenerations: [{ round: 1, notes: 'n', views: [{ view: 'right', request: 'shorter' }] }],
  });
  const p = generationProgress(state)!;
  assert.equal(p.label, 'Regeneration 1');
  assert.equal(p.regeneration, 1);
  assert.deepEqual(states(p), { front: 'kept', back: 'kept', left: 'kept', right: 'generating' });
  assert.equal(p.views[3].candidate, undefined, 'the attempt-1 right is not this one');
  assert.equal(liveLabel(state), 'Generating the right (regeneration 1)');
});

test('a failed view fails, and the views it stopped are not left waiting', () => {
  const state = run()
    .gen('running', 'front', 1, 2)
    .gen('failed', 'front', 1, 5)
    .state({ status: 'failed', failureReason: 'model refused' });
  const p = generationProgress(state)!;
  assert.deepEqual(states(p), {
    front: 'failed',
    back: 'skipped',
    left: 'skipped',
    right: 'skipped',
  });
  assert.equal(liveLabel(state), 'Failed: model refused');
});

test('a retried call generates again', () => {
  const state = run()
    .gen('running', 'front', 1, 2)
    .gen('failed', 'front', 1, 5)
    .gen('running', 'front', 1, 6)
    .state();
  const front = generationProgress(state)!.views[0];
  assert.equal(front.state, 'generating');
  assert.equal(front.startedAt, state.events.at(-1)!.at);
});

test('the live label names the gate, the end and the stage at work', () => {
  const r = run().event('analyse', 'running', 1);
  assert.equal(liveLabel(r.state()), 'Analysing the images');
  assert.equal(liveLabel(r.state({ status: 'awaiting_review' })), 'Waiting for your review');
  assert.equal(liveLabel(r.state({ status: 'approved' })), 'Approved: the views are delivered');
});

test('views join as prose', () => {
  assert.equal(joinViews(['left']), 'left');
  assert.equal(joinViews(['left', 'right']), 'left and right');
  assert.equal(joinViews(['front', 'back', 'left']), 'front, back and left');
});
