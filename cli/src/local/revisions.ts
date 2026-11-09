import { createHash } from 'node:crypto';
import {
  STAGE_IDS,
  type PipelineState,
  type StageDetail,
  type StageEvent,
  type StageId,
  type StageRun,
  type StageStatus,
} from '@sketch-to-product-views/contracts';

/**
 * In-memory revision store for the local runner. The deployed pipeline uses
 * DynamoDB (`PK=USER#{owner}#REV#{id}`, `SK=META | EVENT#{seq}`) behind the same two calls: `patch()` and
 * `emit()`.
 */

const revisions = new Map<string, PipelineState>();

/** Monotonic per-revision event sequence; the UI relies on it for ordering. */
const seqs = new Map<string, number>();

export function initialStages(): Record<StageId, StageRun> {
  return Object.fromEntries(
    STAGE_IDS.map((id) => [id, { status: 'pending' as StageStatus, attempt: 0 }]),
  ) as Record<StageId, StageRun>;
}

export function put(state: PipelineState): void {
  revisions.set(state.revisionId, state);
}

export function get(revisionId: string): PipelineState | undefined {
  return revisions.get(revisionId);
}

export function list(): PipelineState[] {
  return [...revisions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Shallow-merge a patch and bump `updatedAt`. Returns the stored state. */
export function patch(revisionId: string, delta: Partial<PipelineState>): PipelineState {
  const current = revisions.get(revisionId);
  if (!current) throw new Error(`unknown revision: ${revisionId}`);
  const next: PipelineState = { ...current, ...delta, updatedAt: new Date().toISOString() };
  revisions.set(revisionId, next);
  return next;
}

/**
 * Record a stage transition. This is the ONLY way stage status changes: the
 * append-only event log and the `stages` projection are always written together,
 * so they cannot drift.
 */
export function emit(
  revisionId: string,
  stage: StageId,
  status: StageStatus,
  opts: {
    message?: string;
    attempt?: number;
    view?: StageEvent['view'];
    stubbed?: boolean;
    detail?: StageDetail;
  } = {},
): PipelineState {
  const current = revisions.get(revisionId);
  if (!current) throw new Error(`unknown revision: ${revisionId}`);

  const seq = (seqs.get(revisionId) ?? 0) + 1;
  seqs.set(revisionId, seq);
  const at = new Date().toISOString();

  const event: StageEvent = {
    seq,
    revisionId,
    stage,
    status,
    at,
    ...(opts.message ? { message: opts.message } : {}),
    ...(opts.attempt ? { attempt: opts.attempt } : {}),
    ...(opts.view ? { view: opts.view } : {}),
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.stubbed ? { stubbed: true } : {}),
  };

  const prior = current.stages[stage] ?? { status: 'pending', attempt: 0 };
  const run: StageRun = {
    status,
    attempt: opts.attempt ?? prior.attempt,
    ...(opts.message ? { message: opts.message } : {}),
    startedAt: status === 'running' ? at : prior.startedAt,
    ...(status === 'running' ? {} : { endedAt: at }),
    ...(opts.stubbed ? { stubbed: true } : {}),
  };

  return patch(revisionId, {
    stages: { ...current.stages, [stage]: run },
    events: [...current.events, event],
  });
}

/** Weak ETag over the state, so the SPA can poll with `If-None-Match`. */
export function etagFor(state: PipelineState): string {
  const h = createHash('sha1')
    .update(`${state.updatedAt}:${state.events.length}:${state.status}`)
    .digest('hex');
  return `W/"${h}"`;
}
