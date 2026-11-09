import {
  createRetryStrategy,
  JitterStrategy,
  withDurableExecution,
  type DurableContext,
  type RetryDecision,
} from '@aws/durable-execution-sdk-js';
import {
  IMAGE_KIND_LABELS,
  MAX_REGENERATIONS,
  captureDetail,
  changedAttributes,
  completeSpec,
  planImages,
  requestsByView,
  reviewDecisionSchema,
  viewsToRemake,
  type Candidate,
  type CandidateView,
  type Evaluation,
  type PipelineState,
  type ProductSpec,
  type Regeneration,
  type ReviewDecision,
  type SketchAnalysis,
  type StageDetail,
  type StageId,
  type ViewMap,
  SPEC_FIELDS,
  warningFor,
} from '@sketch-to-product-views/contracts';
import { AnalysisInvalidError } from '@sketch-to-product-views/shared/analyse';
import { triageFeedback } from '@sketch-to-product-views/shared/analyse/triage';
import { describeError, errorSummary } from '@sketch-to-product-views/shared/errors';
import {
  GUARDRAIL_OFF_WARNING,
  GuardrailBlockedError,
  guardrailFromEnv,
  screenText,
} from '@sketch-to-product-views/shared/guardrail';
import {
  ContentRefusedError,
  ProviderAccessError,
  VIEW_LABEL,
  PROFILES,
  createImageGenerator,
  imageSettings,
  sketchDraws,
} from '@sketch-to-product-views/shared/generate';
import type { Critic } from '@sketch-to-product-views/shared/qc/critic';
import { createJudgeCritic } from '@sketch-to-product-views/shared/qc/judge';
import { deployedModel, modelById, type ModelEntry } from '@sketch-to-product-views/shared/registry';
import {
  emit,
  getArtifact,
  getRevision,
  deliveryKey,
  patchRevision,
  putArtifact,
  revisionSegment,
  setReviewCallbackId,
  sniffImageType,
  type RevisionRef,
} from '@sketch-to-product-views/shared/store';
import { parsePipelineInput, type PipelineInput } from './input.js';
import { ValidationError, validate, type ValidateResult } from './stages/validate.js';
import { analyse, type AnalyseStageResult } from './stages/analyse.js';
import { generateView } from './stages/generate-2d.js';
import { evaluate2d } from './stages/evaluate-2d.js';

/**
 * The durable function that runs one revision.
 *
 * Real steps: the package is validated against stored bytes, the analyser reads the images
 * and the product metadata, the spec is built from that analysis, an image model renders the
 * front from the sketch and then the back and the two profiles from that front, a multimodal
 * critic scores each view, a human reviews them, and the approved views are delivered. The
 * pipeline ends there.
 *
 * Two rules shape every line below.
 *
 * **Everything durable happens inside a step.** A step's result is checkpointed, so on
 * replay it is not re-executed. That is what makes `new Date()`, `randomUUID()` and a
 * paid Bedrock call safe here: they run once, and every later replay reads the stored
 * answer. Code *outside* a step runs again on every replay and must therefore be pure.
 *
 * **Checkpoints hold decisions, not payloads.** Step results are small — ids, keys,
 * verdicts. Image bytes live in S3 and are passed by key, because the checkpoint budget
 * is 100 MB per execution and cannot be raised.
 */

/** Upload and submit are recorded by the API at submit time; this function owns the rest. */
const generator = createImageGenerator();

/**
 * Marks a failure that has already been reported on the rail, so it is not double-emitted.
 *
 * The original error is kept as `cause`. Without it the wrapper would erase exactly the
 * information the retry strategy needs: a throttle and a refusal both arrive here as
 * "StageFailed", and treating the pair alike means either paying to retry a certain
 * failure or giving up on a fault that would have cleared on its own.
 */
export class StageFailed extends Error {
  constructor(
    readonly stage: StageId,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(reason, options);
    this.name = 'StageFailed';
  }
}

/**
 * HTTP statuses AWS services use for conditions that clear without any change to the
 * request: 408/429 on the client side, 5xx on the server side. OpenAI and the gateway too, except
 * the 429 of an exhausted quota, which the adapters raise as a status-less `ProviderAccessError`.
 */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Error identifiers that mean "the same call may well succeed".
 *
 * The Bedrock Runtime entries are the exceptions its client actually throws
 * (`ThrottlingException`, `InternalServerException`, `ServiceUnavailableException`,
 * `ModelNotReadyException`, `ModelTimeoutException` — see `@aws-sdk/client-bedrock-runtime`
 * models); the rest are the throttle aliases shared across AWS services and the socket
 * errors the Node HTTP handler surfaces. Anything not listed here and carrying no
 * transient status code is treated as deterministic and fails fast, which is the safe
 * direction to be wrong in for a paid generation call.
 */
const TRANSIENT_NAMES = new Set([
  // The analyser's answer ignored its schema (see `sketch-analyser.ts`); the next call to the
  // same request usually complies.
  'AnalysisMalformedError',
  'ThrottlingException',
  'ThrottledException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'SlowDown',
  'InternalServerException',
  'InternalServerError',
  'InternalFailure',
  'InternalError',
  'ServiceUnavailableException',
  'ServiceUnavailable',
  'ModelNotReadyException',
  'ModelTimeoutException',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'NetworkingError',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  // Node's `fetch` (undici) failures, found in `cause`. `ENOTFOUND` is left out: a host that does
  // not resolve is configuration.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Classifies a failure by walking the `cause` chain, because every stage failure reaches
 * the retry strategy wrapped in a `StageFailed`.
 *
 * A validation failure, a content refusal, an invalid analysis, a guardrail block or a provider
 * that denies access (a bad key, an exhausted quota) short-circuits to "terminal" wherever it
 * appears in the chain:
 * retrying any of them would fail identically and, for generation, would pay for the privilege.
 * The depth bound is there only so a self-referential `cause` cannot loop forever.
 *
 * Pure, so it is safe to call from a retry strategy, which the SDK evaluates outside a step.
 */
export function isTransient(error: unknown, depth = 0): boolean {
  if (depth > 5 || !(error instanceof Error)) return false;
  if (
    error instanceof ValidationError ||
    error instanceof ContentRefusedError ||
    error instanceof AnalysisInvalidError ||
    error instanceof GuardrailBlockedError ||
    error instanceof ProviderAccessError
  ) {
    return false;
  }

  const aws = error as {
    code?: string;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };

  // The AWS SDK's own verdict, when it offers one, outranks any list kept here.
  if (aws.$retryable) return true;
  if (TRANSIENT_NAMES.has(error.name)) return true;
  if (typeof aws.code === 'string' && TRANSIENT_NAMES.has(aws.code)) return true;

  const status = aws.$metadata?.httpStatusCode;
  if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;

  return isTransient(error.cause, depth + 1);
}

/**
 * The delay schedule, from the SDK rather than hand-rolled. Jitter is switched off on
 * purpose: `createRetryStrategy`'s default `FULL` jitter draws from `Math.random()`, and
 * this function is evaluated by the SDK outside a step, so a deterministic schedule is the
 * one that cannot differ between the first run and a replay.
 */
const transientBackoff = createRetryStrategy({
  maxAttempts: 3,
  initialDelay: { seconds: 2 },
  maxDelay: { seconds: 20 },
  backoffRate: 2,
  jitter: JitterStrategy.NONE,
});

/**
 * Retrying a refusal or a bad package would fail identically and, for generation, would
 * pay for the privilege. A throttle, a timeout or a 5xx is worth another attempt, so only
 * those get the backoff schedule above.
 */
export const retryStrategy = (error: Error, attemptCount: number): RetryDecision =>
  isTransient(error) ? transientBackoff(error, attemptCount) : { shouldRetry: false };

/**
 * Environment variables are read outside steps on purpose: a Lambda version's configuration
 * is immutable, so the value is the same on every replay. An unset, empty or malformed
 * value falls back to the default rather than propagating a `NaN` into a loop bound or a
 * timeout, where it would silently mean "zero attempts" or "no deadline".
 */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolved at module level so an unknown or non-analyser id fails the cold start, not a run. */
export const analyserModel = deployedModel('analyser', process.env.ANALYSER_MODEL).id;

const critic: Critic = createJudgeCritic();

// Read at cold start, so a GUARDRAIL_ID without a version fails the deployment, not a run.
if (!guardrailFromEnv()) console.warn({ message: GUARDRAIL_OFF_WARNING });

/** The critic Terraform set (`EVALUATION_MODEL`), resolved at cold start like the analyser. */
export const criticModel = deployedModel('critic', process.env.EVALUATION_MODEL);

/**
 * The run's own settings first, then the deployment's (`IMAGE_SIZE`, `IMAGE_QUALITY`), then the
 * image entry's registry defaults. Checked against the entry per run, since a run may name its
 * own image model. Pure, so the same on every replay.
 */
const imageOverridesFor = (input: PipelineInput) => ({
  size: input.settings?.size || process.env.IMAGE_SIZE,
  quality: input.settings?.quality || process.env.IMAGE_QUALITY,
  complexity: input.settings?.complexity,
});

/**
 * Runs one stage as a durable step, bracketed by the two events the UI renders.
 *
 * The emits are inside the step so that a replay does not re-announce work that already
 * happened. A genuine SDK retry *does* re-emit `running`, which is intended: the rail
 * should show that the stage was attempted twice. The resulting
 * `running → failed → running → passed` run stays coherent because the event log is
 * append-only with a server-minted sequence number, and the `stages` projection is
 * rebuilt from each transition rather than merged — so it always reads as the latest
 * transition, never as a mixture of two attempts. The retry number is carried in the
 * message, not in the event's `attempt` field, which belongs to the generate-and-evaluate loop.
 *
 * `opts.attempt` is appended to the step name, never omitted for a stage that runs in the
 * generate-and-evaluate loop, and `opts.view` before it for a stage that runs once per view. Two
 * steps sharing a name within one execution is exactly the case where checkpoint matching is
 * ambiguous, and getting it wrong would mean attempt 2 silently replaying attempt 1's rejected
 * candidate — an infinite loop that looks like a pass.
 *
 * Each attempt is also one log line through the step's logger, which the SDK suppresses on
 * replay: `info` for a pass, `warn` for a failure that will be retried, `error` otherwise.
 */
async function stage<T>(
  ctx: DurableContext,
  rev: RevisionRef,
  id: StageId,
  opening: string,
  fn: () => Promise<{ result: T; message: string; detail?: StageDetail }>,
  opts: {
    attempt?: number;
    view?: CandidateView;
    detail?: StageDetail;
    model?: ModelEntry;
    /** The step's name, for a stage that runs once per review round rather than per attempt. */
    step?: string;
  } = {},
): Promise<T> {
  const stepName =
    opts.step ?? [id, opts.view, opts.attempt].filter((p) => p !== undefined).join('-');
  const model = opts.model && {
    id: opts.model.id,
    provider: opts.model.provider,
    region: opts.model.region,
  };

  return ctx.step(
    stepName,
    async (step) => {
      // `step.attempt` is the SDK's retry counter for this step, 1 on the first run. It is
      // read here rather than derived from anything mutable, so a replay reports the same
      // number it reported the first time round.
      const retry = step.attempt > 1 ? ` (retry ${step.attempt - 1})` : '';
      const fields = {
        revisionId: rev.revisionId,
        stage: id,
        step: stepName,
        stepAttempt: step.attempt,
        generationAttempt: opts.attempt,
        view: opts.view,
        model,
      };
      const started = Date.now();

      // The opening event carries only what is known before the work runs, which is the
      // stage's input. Its output is unknowable here and is recorded on the closing event.
      await emit(rev, id, 'running', {
        message: `${opening}${retry}`,
        attempt: opts.attempt,
        view: opts.view,
        detail: opts.detail,
      });
      try {
        const { result, message, detail } = await fn();
        await emit(rev, id, 'passed', {
          message,
          attempt: opts.attempt,
          view: opts.view,
          detail,
        });
        step.logger.info({ event: 'stage_passed', ...fields, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        const reason = errorSummary(error);
        // `cause` is what makes `retryStrategy` able to tell a throttle from a refusal.
        const failed = new StageFailed(id, reason, { cause: error });
        // The SDK calls the same pure strategy with the same attempt, so this is its decision.
        const willRetry = retryStrategy(failed, step.attempt).shouldRetry;

        // Logged before the event is written, so a store that is down too cannot hide it.
        step.logger[willRetry ? 'warn' : 'error']({
          event: 'stage_failed',
          ...fields,
          durationMs: Date.now() - started,
          willRetry,
          reason,
          error: describeError(error),
        });
        // A failure keeps the input on the record. Knowing what a stage was handed is most
        // valuable in exactly the case where it could not finish.
        await emit(rev, id, 'failed', {
          message: `${reason}${retry}`,
          attempt: opts.attempt,
          view: opts.view,
          detail: opts.detail,
        });
        throw failed;
      }
    },
    { retryStrategy },
  );
}

/**
 * An error the run could not turn into a failed revision (an unreadable payload, a store that
 * refused the verdict) is logged before it is rethrown: the SDK records it on the execution but
 * not in the function's log. Exported unwrapped for the tests.
 */
export async function runDurable(event: unknown, ctx: DurableContext) {
  try {
    return await runExecution(event, ctx);
  } catch (error) {
    const revisionId = (event as { revisionId?: unknown } | null)?.revisionId;
    ctx.logger.error({
      event: 'unhandled_error',
      revisionId: typeof revisionId === 'string' ? revisionId : undefined,
      reason: errorSummary(error),
      error: describeError(error),
    });
    throw error;
  }
}

export const handler = withDurableExecution(runDurable);

async function runExecution(event: unknown, ctx: DurableContext) {
  const input = parsePipelineInput(event);
  const { revisionId } = input;
  const rev = refOf(input);

  try {
    await runRevision(ctx, input);
    return { revisionId, status: 'approved' };
  } catch (error) {
    const reason = errorSummary(error);

    // The stage-level event was already emitted by `stage()`; this records the verdict on
    // the revision itself so the UI can state why the run stopped.
    await ctx.step('mark-failed', async (step) => {
      step.logger.error({ event: 'run_failed', revisionId, reason, error: describeError(error) });
      await patchRevision(rev, { status: 'failed', failureReason: reason });
    });

    return { revisionId, status: 'failed', reason };
  }
}

/**
 * The key prefix every artifact this run writes lives under.
 *
 * Derived from the revision's stored `createdAt`, which the payload carries — never from
 * `new Date()`, which outside a step would differ between the first run and a replay and
 * would then write attempt 2 under a different prefix than attempt 1. Pure, so no step.
 */
function revisionSegmentOf(input: PipelineInput): string {
  return revisionSegment(input.createdAt, input.revisionId);
}

/**
 * The revision's address in the store: its id and its owner, who is part of every key. The
 * owner is the `submittedBy` the API took from the verified claims, carried in the payload.
 */
function refOf(input: PipelineInput): RevisionRef {
  return { owner: input.submittedBy, revisionId: input.revisionId };
}

/**
 * Validate the stored package, analyse the images and the product metadata,
 * and build the specification from the analysis. Exported so the rail can be tested without
 * the 2D loop behind it.
 */
export async function runIntake(ctx: DurableContext, input: PipelineInput): Promise<ProductSpec> {
  const rev = refOf(input);

  // Validate package
  await stage(ctx, rev, 'validate', 'Reading each input from storage.', async () => {
    const checked = await validate(input);
    return { result: null, message: checked.message, detail: validateDetail(input, checked) };
  });

  // Analyse images. The only source of the spec, so a failure here fails the run.
  const analysed = await stage(
    ctx,
    rev,
    'analyse',
    'Reading the images and the product details.',
    async () => {
      const result = await analyse(input, analyserModel);
      await patchRevision(rev, { analysis: result.analysis });
      return {
        result: result.analysis,
        message: analysisMessage(result),
        detail: analysisDetail(input, result),
      };
    },
    { model: modelById(analyserModel) },
  );

  // Complete specification
  const spec = await stage(
    ctx,
    rev,
    'complete_spec',
    'Building the specification from the analysis.',
    async () => {
      // The material sample is the analyser's decision; a run analysed before then, its roles'.
      const kinds = analysed.images?.map((i) => i.kind);
      const hasMaterial = planImages(input.inputs, kinds).material !== undefined;
      const completed = completeSpec(input.productId, analysed, { hasMaterial });
      const warning = warningFor(completed, { hasMaterial });
      await patchRevision(rev, { spec: completed, warning });
      return {
        result: completed,
        message: specMessage(completed),
        detail: specDetail(analysed, completed, warning),
      };
    },
  );

  return spec;
}

async function runRevision(ctx: DurableContext, input: PipelineInput): Promise<void> {
  const rev = refOf(input);
  const revSegment = revisionSegmentOf(input);
  const spec = await runIntake(ctx, input);

  const budget = input.settings?.attemptBudget ?? positiveIntFromEnv('ATTEMPT_BUDGET', 2);
  // Rebuilt from the replayed step results, like the 2D loop's `previous`.
  const regenerations: Regeneration[] = [];
  const notes = input.requests?.notes;
  const guidance = notes
    ? await routeGuidance(ctx, input, spec, notes, input.requests?.reviewedBy)
    : undefined;
  let accepted = await twoDLoop(
    ctx,
    input,
    spec,
    budget,
    revSegment,
    guidance && {
      requests: requestsByView([guidance]),
      changed: changedAttributes([guidance]),
    },
  );

  for (let round = 0; ; round += 1) {
    const gate = await review(ctx, rev, accepted, round);
    const { decision } = gate;
    if (decision.decision === 'approve') break;
    if (regenerations.length >= MAX_REGENERATIONS) {
      throw new StageFailed(
        'human_review',
        `Reviewer asked to regenerate after the ${MAX_REGENERATIONS} regenerations a run allows.`,
      );
    }

    const regeneration = await triage(
      ctx,
      input,
      spec,
      decision.notes ?? '',
      gate.reviewedBy,
      regenerations,
    );
    regenerations.push(regeneration);
    const given = [...(guidance ? [guidance] : []), ...regenerations];
    accepted = await regenerate(ctx, input, spec, revSegment, {
      round: regeneration.round,
      accepted,
      asked: regeneration.views.map((v) => v.view),
      requests: requestsByView(given),
    });
  }

  await deliver(ctx, input, accepted, revSegment);
}

/** The notes of a first generation, routed to the views like a regeneration's. */
type Guidance = NonNullable<PipelineState['guidance']>;

/**
 * Routes the reviewer's description to the views it concerns (`triageFeedback`) and records
 * the regeneration on the revision, where the UI lists it.
 */
async function triage(
  ctx: DurableContext,
  input: PipelineInput,
  spec: ProductSpec,
  notes: string,
  reviewedBy: string | undefined,
  earlier: readonly Regeneration[],
): Promise<Regeneration> {
  const round = earlier.length + 1;
  return stage(
    ctx,
    refOf(input),
    'human_review',
    'Reading which views the reviewer asks to change.',
    async () => {
      // Screened again here: the API did, but the callback crosses a trust boundary.
      await screenText([{ label: 'Review notes', text: notes }]);
      const result = await triageFeedback({ notes, spec, modelId: analyserModel });
      await screenRequests(result.views);
      const regeneration: Regeneration = {
        round,
        notes,
        views: result.views,
        attributes: result.attributes,
        ...(reviewedBy ? { reviewedBy } : {}),
      };
      await patchRevision(refOf(input), { regenerations: [...earlier, regeneration] });
      const remade = viewsToRemake(result.views.map((v) => v.view));
      return {
        result: regeneration,
        message: `Regeneration ${round}: remaking ${remade.map((v) => `the ${VIEW_LABEL[v]}`).join(', ')}.`,
        detail: triageDetail(notes, result, remade, round),
      };
    },
    { step: `triage-${round}`, model: modelById(analyserModel) },
  );
}

/**
 * The design team's notes on a product with no 2D yet, routed to the views like a reviewer's
 * description so each view's generator gets only its part, in English. Recorded as `guidance`.
 */
async function routeGuidance(
  ctx: DurableContext,
  input: PipelineInput,
  spec: ProductSpec,
  notes: string,
  reviewedBy: string | undefined,
): Promise<Guidance> {
  return stage(
    ctx,
    refOf(input),
    'complete_spec',
    'Reading which views the design team notes concern.',
    async () => {
      // The notes were screened at validate; the requests are new text for the image model.
      const result = await triageFeedback({ notes, spec, modelId: analyserModel });
      await screenRequests(result.views);
      const guidance: Guidance = {
        notes,
        views: result.views,
        attributes: result.attributes,
        ...(reviewedBy ? { reviewedBy } : {}),
      };
      await patchRevision(refOf(input), { guidance });
      const views = result.views.map((v) => v.view);
      return {
        result: guidance,
        message: `Design team notes sent to ${views.map((v) => `the ${VIEW_LABEL[v]}`).join(', ')}.`,
        detail: triageDetail(notes, result, views, 0),
      };
    },
    { step: 'triage-guidance', model: modelById(analyserModel) },
  );
}

/** The triage's requests go into the image prompt and the critic: screened as input. */
async function screenRequests(views: readonly { request: string }[]): Promise<void> {
  await screenText([{ label: 'Per-view requests', text: views.map((v) => v.request).join('\n') }]);
}

function triageDetail(
  notes: string,
  result: Awaited<ReturnType<typeof triageFeedback>>,
  remade: CandidateView[],
  round: number,
): StageDetail {
  return captureDetail({
    input: { notes },
    output: { views: result.views, remade, attributes: result.attributes },
    facts: {
      round,
      asked: result.views.map((v) => v.view).join(', '),
      remade: remade.join(', '),
      changed: result.attributes.join(', '),
      model: result.model.name,
      promptVersion: result.promptVersion,
      latencyMs: result.latencyMs,
    },
  });
}

/** The accepted attempt: its front, which review reads, and every view it produced. */
export interface Accepted {
  front: Candidate;
  views: Candidate[];
  /** The highest attempt number used so far, kept or not; the next attempt is numbered after it. */
  lastAttempt: number;
  /** True when the critic did not score this attempt: a regeneration is one unscored attempt. */
  unscored?: true;
}

/** A regeneration a reviewer asked for, starting from the views they reviewed. */
export interface RegenerationRound {
  /** 1-based, as `Regeneration.round`. */
  round: number;
  /** The views the reviewer saw. */
  accepted: Accepted;
  /** The views the reviewer's description concerns. */
  asked: readonly CandidateView[];
  /** Every request each view was given so far, sent whenever that view is made. */
  requests: Partial<Record<CandidateView, string[]>>;
}

/**
 * The verdict of an attempt from the verdicts of its views: a failed view fails the attempt,
 * since the other views were made from the same front and are regenerated with it.
 */
export function attemptVerdict(verdicts: readonly Evaluation[]): Evaluation['verdict'] {
  if (verdicts.some((v) => v.verdict === 'fail')) return 'fail';
  return verdicts.some((v) => v.verdict === 'warn') ? 'warn' : 'pass';
}

/** An attempt of the 2D loop: every view it would deliver, each with its verdict. */
export interface TriedAttempt {
  attempt: number;
  views: Candidate[];
}

const meanScore = (e: Evaluation) =>
  (e.scores.sketchFidelity + e.scores.specAdherence + e.scores.imageQuality) / 3;

/**
 * The attempt to keep when the critic rejected them all: the most views approved (a `warn`
 * counts), then the higher mean score across its views, then the later attempt.
 */
export function bestAttempt(tried: readonly TriedAttempt[]): TriedAttempt {
  if (tried.length === 0) throw new Error('no attempt to choose from');
  const rank = (t: TriedAttempt) => {
    const verdicts = t.views.flatMap((c) => (c.evaluation ? [c.evaluation] : []));
    const approved = verdicts.filter((v) => v.verdict !== 'fail').length;
    const score =
      verdicts.length > 0
        ? verdicts.reduce((sum, v) => sum + meanScore(v), 0) / verdicts.length
        : 0;
    return { approved, score };
  };
  return tried.reduce((best, t) => {
    const a = rank(t);
    const b = rank(best);
    if (a.approved !== b.approved) return a.approved > b.approved ? t : best;
    if (a.score !== b.score) return a.score > b.score ? t : best;
    return t.attempt > best.attempt ? t : best;
  });
}

/** How many issues the outcome keeps: enough to say what is wrong, few enough to read. */
const OUTCOME_ISSUES = 5;

/** The critic's issues with the rejected views of an attempt, front first, each once. */
export function rejectedIssues(views: readonly Candidate[]): string[] {
  const issues = views.flatMap((c) =>
    c.evaluation?.verdict === 'fail' ? c.evaluation.issues.map((i) => i.trim()) : [],
  );
  return [...new Set(issues.filter(Boolean))].slice(0, OUTCOME_ISSUES);
}

/** What an attempt remakes, and what each view it makes is told. */
interface AttemptPlan {
  attempt: number;
  /** The run's own words for the attempt, at the head of each view's opening message. */
  label: string;
  /** The views of the attempt before, which a view not remade is kept from. */
  last?: readonly Candidate[];
  redoFront: boolean;
  redoBack: boolean;
  redoProfiles: readonly CandidateView[];
  corrections: (view: CandidateView) => string[] | undefined;
  requests: Partial<Record<CandidateView, string[]>> | undefined;
}

/**
 * Makes the views of one attempt, front first, then the back, then the two profiles together,
 * each its own durable step so a failed call retries alone, and records them. Returns every
 * view the attempt would deliver, front first, the kept ones included.
 */
async function makeAttempt(
  ctx: DurableContext,
  input: PipelineInput,
  spec: ProductSpec,
  revSegment: string,
  plan: AttemptPlan,
): Promise<Candidate[]> {
  const { attempt, label } = plan;
  const entry = modelById(input.modelId);
  // Pure, from the registry and the environment, so the same on every replay. A size or
  // quality the entry does not offer fails here, before any call is paid for.
  const settings = imageSettings(entry, imageOverridesFor(input));
  const hasSwatch =
    entry.acceptsInputs.includes('swatch') &&
    planImages(input.inputs, spec.imageKinds).material !== undefined;
  const kept = (view: CandidateView) => plan.last!.find((c) => (c.view ?? 'front') === view)!;

  const viewStep =
    (view: CandidateView, from: string, refs: { front?: Candidate; back?: Candidate }) =>
    (context: DurableContext) =>
      stage(
        context,
        refOf(input),
        'generate_2d',
        `${label}${view === 'front' ? ` with ${entry.name}` : ''}: the ${VIEW_LABEL[view]}, ${from}.`,
        async () => {
          const candidate = await generateView(input, spec, attempt, view, generator, revSegment, {
            settings,
            ...refs,
            corrections: plan.corrections(view),
            requests: plan.requests?.[view],
          });
          if (view === 'front') await appendCandidates(refOf(input), [candidate]);
          return {
            result: candidate,
            message: producedMessage(candidate),
            detail: candidateDetail(candidate, entry.name, label, settings),
          };
        },
        { attempt, view, model: entry },
      );
  const withSketch = (view: CandidateView) =>
    sketchDraws(spec, view) ? `, the sketch${hasSwatch ? ' and the material sample' : ''}` : '';

  const front = plan.redoFront
    ? await viewStep(
        'front',
        `from the sketch${hasSwatch ? ' and the material sample' : ''}`,
        {},
      )(ctx)
    : kept('front');

  // The back before the profiles: a profile joins the front edge and the back edge, so it is
  // given both renders. This costs one call's time per attempt, for views that agree.
  const back = plan.redoBack
    ? await viewStep('back', `from the front render${withSketch('back')}`, { front })(ctx)
    : kept('back');

  // The two profiles run together. They write no candidate: two steps appending to one list
  // would lose each other's writes, so the attempt records the views it made in one step once
  // all are done.
  const batch = await ctx.parallel(
    `views-${attempt}`,
    plan.redoProfiles.map((view) => ({
      name: view,
      func: viewStep(view, `from the front and back renders${withSketch(view)}`, { front, back }),
    })),
  );
  const failures = batch.failed();
  if (failures.length > 0) {
    // Each branch already reported its own failure on the rail; this names the run's.
    throw new StageFailed('generate_2d', failures.map((f) => errorSummary(f.error)).join(' | '), {
      cause: failures[0].error,
    });
  }
  const profiles = batch.getResults();
  const others = [...(plan.redoBack ? [back] : []), ...profiles];
  await ctx.step(`record_2d-${attempt}`, async () => {
    await appendCandidates(refOf(input), others);
  });
  return [
    front,
    back,
    ...PROFILES.map((view) => profiles.find((c) => c.view === view) ?? kept(view)),
  ];
}

/**
 * The generate-and-evaluate loop of a first generation. Each attempt is four calls, one image
 * each: the front from the sketch, then the back, the left and the right from that front; then
 * every view is scored as that view. A failed view fails the attempt and is retried within the
 * budget; `warn` is accepted, because a warned candidate is exactly what the human review stage
 * is for. Exported, like `runIntake`, so the loop and its storage can be tested without the
 * durable runtime.
 *
 * Once the budget is spent with every attempt rejected, the best attempt (`bestAttempt`) goes to
 * the reviewer rather than failing the run, with `criticOutcome.approved` false: the reviewer, not
 * the critic, has the last word.
 */
export async function twoDLoop(
  ctx: DurableContext,
  input: PipelineInput,
  spec: ProductSpec,
  budget: number,
  revSegment: string,
  /** The design team's notes routed to the views; see `routeGuidance`. */
  guidance?: { requests: Partial<Record<CandidateView, string[]>>; changed: readonly string[] },
): Promise<Accepted> {
  // Rebuilt from the replayed step results, so a resumed execution makes the same calls.
  let previous: { views: Candidate[]; verdicts: Evaluation[] } | undefined;
  const tried: TriedAttempt[] = [];
  const select = async (chosen: TriedAttempt, approved: boolean): Promise<Accepted> => {
    const accepted = chosen.views[0];
    await ctx.step(`select-${chosen.attempt}`, async () => {
      await patchRevision(refOf(input), {
        selectedCandidateId: accepted.id,
        selectedViews: viewMap(chosen.views.map((c) => [c.view ?? 'front', c.id])),
        attempt: chosen.attempt,
        criticOutcome: {
          approved,
          attempt: chosen.attempt,
          attempts: tried.length,
          issues: approved ? [] : rejectedIssues(chosen.views),
        },
      });
      if (!approved) {
        await emit(refOf(input), 'evaluate_2d', 'passed', {
          attempt: chosen.attempt,
          message: `The critic rejected all ${tried.length} attempt(s); attempt ${chosen.attempt}, the best, goes to review.`,
        });
      }
    });
    return { front: accepted, views: chosen.views, lastAttempt: tried.at(-1)!.attempt };
  };
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    // A retry remakes only the rejected views, each told what was wrong with it. A rejected
    // front remakes all four, since the others are made from it.
    const last = previous;
    const verdictOf = (view: CandidateView) =>
      last?.verdicts[last.views.findIndex((c) => (c.view ?? 'front') === view)];
    const failed = (view: CandidateView) => verdictOf(view)?.verdict === 'fail';
    // Each view is made from the ones before it, so remaking one remakes those after it too.
    const redoFront = !last || failed('front');
    const redoBack = redoFront || failed('back');
    const produced = await makeAttempt(ctx, input, spec, revSegment, {
      attempt,
      label: `Attempt ${attempt} of ${budget}`,
      last: last?.views,
      redoFront,
      redoBack,
      redoProfiles: PROFILES.filter((view) => redoBack || failed(view)),
      corrections: (view) => {
        const verdict = verdictOf(view);
        return verdict?.verdict === 'fail' ? verdict.issues : undefined;
      },
      requests: guidance?.requests,
    });

    // One step for the views of the attempt, scored in parallel. A view kept from an earlier
    // attempt keeps its verdict: its image did not change.
    const verdicts = await stage(
      ctx,
      refOf(input),
      'evaluate_2d',
      'Scoring each view against the sketch and the specification.',
      async () => {
        const scored = await Promise.all(
          produced.map((candidate) =>
            candidate.attempt === attempt
              ? evaluate2d(input, spec, candidate, critic, criticModel.id, {
                  requests: guidance?.requests[candidate.view ?? 'front'],
                  changed: guidance?.changed,
                })
              : Promise.resolve(verdictOf(candidate.view ?? 'front')!),
          ),
        );
        await updateCandidates(
          refOf(input),
          new Map(
            produced
              .map((c, i) => [c, scored[i]] as const)
              .filter(([c]) => c.attempt === attempt)
              .map(([c, evaluation]) => [c.id, { evaluation }]),
          ),
        );
        return {
          result: scored,
          message: produced
            .map((c, i) => {
              const v = scored[i];
              return `${c.view ?? 'front'} ${v.verdict}${v.issues.length > 0 ? `: ${v.issues.join('; ')}` : ''}`;
            })
            .join(' | '),
          detail: evaluationsDetail(produced, spec, scored, attempt),
        };
      },
      { attempt, model: criticModel },
    );

    previous = { views: produced, verdicts };
    tried.push({ attempt, views: produced.map((c, i) => ({ ...c, evaluation: verdicts[i] })) });
    if (attemptVerdict(verdicts) !== 'fail') return select(tried.at(-1)!, true);
  }

  return select(bestAttempt(tried), false);
}

/**
 * A regeneration: one attempt, no critic. It starts from the views the reviewer saw and remakes
 * the ones their description asks for, with the views made from them (a new front remakes all
 * four, a new back both profiles), each given every request its view has had. The attempt is
 * numbered on from the last one made, so no step name repeats, and goes straight to review: the
 * reviewer who wrote the requests judges whether they were met. The critic's outcome is replaced,
 * so it cannot be read as the critic's word on these views.
 */
export async function regenerate(
  ctx: DurableContext,
  input: PipelineInput,
  spec: ProductSpec,
  revSegment: string,
  regeneration: RegenerationRound,
): Promise<Accepted> {
  const last = regeneration.accepted.views;
  // After the last attempt made, not the one kept: the loop may keep attempt 1 of 2, and
  // reusing attempt 2's step names would replay its checkpoints.
  const attempt = regeneration.accepted.lastAttempt + 1;
  const asked = (view: CandidateView) => regeneration.asked.includes(view);
  const redoFront = asked('front');
  const redoBack = redoFront || asked('back');
  const produced = await makeAttempt(ctx, input, spec, revSegment, {
    attempt,
    label: `Regeneration ${regeneration.round}`,
    last,
    redoFront,
    redoBack,
    redoProfiles: PROFILES.filter((view) => redoBack || asked(view)),
    corrections: () => undefined,
    requests: regeneration.requests,
  });

  await ctx.step(`select-${attempt}`, async () => {
    await patchRevision(refOf(input), {
      selectedCandidateId: produced[0].id,
      selectedViews: viewMap(produced.map((c) => [c.view ?? 'front', c.id])),
      attempt,
      criticOutcome: { evaluated: false as const, attempt },
    });
  });
  return { front: produced[0], views: produced, lastAttempt: attempt, unscored: true };
}

/**
 * The human review gate: park until a human decides.
 *
 * `waitForCallback` consumes no compute while waiting. The callback id is written to the
 * revision inside the submitter, which is the only place it can go: the API resolves the
 * wait by reading it back, and it must never be sent to the browser.
 */
async function review(
  ctx: DurableContext,
  rev: RevisionRef,
  accepted: Accepted,
  /** The review round, 0 before the first regeneration; part of every later step name. */
  round: number,
): Promise<{ decision: ReviewDecision; reviewedBy?: string }> {
  const days = positiveIntFromEnv('REVIEW_TIMEOUT_DAYS', 7);
  const step = (name: string) => (round === 0 ? name : `${name}-${round + 1}`);
  const candidate = accepted.front;
  // Only after a first generation whose budget ran out: the reviewer sees what the critic
  // rejects. A regeneration's views are unscored, and a verdict on a view it kept is stale.
  const rejected = accepted.unscored
    ? []
    : accepted.views.filter((c) => c.evaluation?.verdict === 'fail');

  let raw: string;
  try {
    raw = await ctx.waitForCallback<string>(
      step('human_review'),
      async (callbackId) => {
        await setReviewCallbackId(rev, callbackId);
        await patchRevision(rev, { status: 'awaiting_review' });
        await emit(rev, 'human_review', 'awaiting_review', {
          message: `Candidate ${candidate.id.slice(0, 8)} is waiting for a decision.${
            rejected.length > 0
              ? ` The critic still rejects ${rejected.map((c) => `the ${VIEW_LABEL[c.view ?? 'front']}`).join(', ')}.`
              : ''
          }`,
        });
      },
      { timeout: { days } },
    );
  } catch (error) {
    // A timeout or a failure callback: record it on the rail, then fail the run.
    const reason = `No review decision: ${errorSummary(error)}`;
    await ctx.step(step('review-failed'), async () => {
      await emit(rev, 'human_review', 'failed', { message: reason });
    });
    throw new StageFailed('human_review', reason, { cause: error });
  }

  const body = JSON.parse(raw) as { reviewedBy?: unknown };
  const decision = reviewDecisionSchema.parse(body);
  const reviewedBy = typeof body.reviewedBy === 'string' ? body.reviewedBy : undefined;

  await ctx.step(step('record-review'), async () => {
    // The gate is closed: a second decision would find no callback to complete.
    await patchRevision(rev, { status: 'running' });
    await emit(rev, 'human_review', 'passed', {
      message: `Reviewer chose to ${decision.decision}.`,
      detail: captureDetail({
        input: { candidateId: candidate.id, waitedDays: days },
        output: decision,
        facts: { decision: decision.decision, notes: decision.notes },
      }),
    });
  });

  return { decision, reviewedBy };
}

/**
 * One value per view of an attempt, the front required: the shape of `selectedViews` and
 * `deliveryKeys`. Built from the views themselves, so a view can never be left out of either.
 */
function viewMap(entries: [CandidateView, string][]): ViewMap {
  const map = Object.fromEntries(entries) as Partial<ViewMap>;
  if (!map.front) throw new Error('the attempt has no front view');
  return map as ViewMap;
}

/**
 * Copy every approved view to the delivery prefix and mark the run approved. The front keeps
 * the name delivered before the other views existed; the others carry their view.
 */
export async function deliver(
  ctx: DurableContext,
  input: PipelineInput,
  accepted: Accepted,
  revSegment: string,
): Promise<void> {
  await stage(ctx, refOf(input), 'deliver', 'Publishing the approved views.', async () => {
    const delivered: {
      view: CandidateView;
      key: string;
      filename: string;
      bytes: number;
    }[] = [];
    for (const candidate of accepted.views) {
      if (!candidate.key) throw new Error(`approved candidate ${candidate.id} has no stored image`);
      const view = candidate.view ?? 'front';
      const bytes = await getArtifact(candidate.key);
      const ext = candidate.key.split('.').pop() ?? 'png';
      const filename =
        view === 'front'
          ? `${input.productId}-approved.${ext}`
          : `${input.productId}-approved-${view}.${ext}`;
      // `filename` is deterministic per product, so the revision segment is the only thing
      // stopping a second approved run from overwriting this product's previous delivery.
      const key = deliveryKey(input.submittedBy, input.productId, revSegment, filename);
      // The type the bytes actually are, not the type the candidate was assumed to be: a JPEG
      // delivered as `image/png` downloads as a file no viewer will open.
      await putArtifact(key, bytes, sniffImageType(bytes) ?? 'image/png');
      delivered.push({ view, key, filename, bytes: bytes.byteLength });
    }

    const deliveryKeys = viewMap(delivered.map((d) => [d.view, d.key]));
    await patchRevision(refOf(input), {
      status: 'approved',
      deliveryKey: deliveryKeys.front,
      deliveryKeys,
    });
    return {
      result: null,
      message: delivered.map((d) => d.filename).join(', '),
      detail: captureDetail({
        input: { candidateIds: accepted.views.map((c) => c.id) },
        output: { delivered },
        facts: {
          views: delivered.length,
          filename: delivered.find((d) => d.view === 'front')?.filename,
        },
      }),
    };
  });
}

/**
 * The `detail` payloads the rail renders, kept out of the stage bodies above so those read
 * as "what the stage does" rather than "what the stage reports". All are pure.
 */
function validateDetail(input: PipelineInput, checked: ValidateResult): StageDetail {
  return captureDetail({
    // The manifest as submitted, minus the URLs: those are re-minted on every read, so
    // recording one would store a credential that is expired by the time anyone looks.
    input: input.inputs.map(({ filename, key }) => ({ filename, key })),
    output: { checks: checked.checks, warnings: checked.warnings },
    facts: {
      filesChecked: checked.checks.length,
      warnings: checked.warnings.length,
      guardrail: checked.screened.guardrail
        ? `${checked.screened.fields} field(s) screened`
        : 'off',
    },
  });
}

function analysisMessage(result: AnalyseStageResult): string {
  const { analysis } = result;
  const views = analysis.views.join(', ') || 'no view';
  const kinds = (analysis.images ?? []).map((i) => IMAGE_KIND_LABELS[i.kind].toLowerCase());
  const read = kinds.length > 0 ? ` (${kinds.join(', ')})` : '';
  return `${result.imageKeys.length} image(s) read${read}: ${views}; ${analysis.details.length} detail(s).`;
}

function analysisDetail(input: PipelineInput, result: AnalyseStageResult): StageDetail {
  return captureDetail({
    input: { images: result.imageKeys, productMetadata: Boolean(input.productMetadata) },
    output: result.analysis,
    facts: {
      model: result.model.name,
      promptVersion: result.promptVersion,
      latencyMs: result.latencyMs,
    },
  });
}

/** "Supplied: productType, colorDescription. Observed: materialDescription." — which fields came from where. */
function specMessage(spec: ProductSpec): string {
  const by = (provenance: 'supplied' | 'observed') =>
    SPEC_FIELDS.filter((key) => spec[key]?.provenance === provenance);
  const parts = [
    by('supplied').length > 0 ? `Supplied: ${by('supplied').join(', ')}.` : '',
    by('observed').length > 0 ? `Observed: ${by('observed').join(', ')}.` : '',
  ].filter(Boolean);
  return parts.join(' ') || 'Nothing supplied or observed; the images alone describe the product.';
}

/**
 * The analysis and the specification built from it, side by side, with the provenance count.
 * Nothing is defaulted, so every field is supplied, observed or left unspecified.
 */
function specDetail(
  analysis: SketchAnalysis,
  completed: ProductSpec,
  warning: string | undefined,
): StageDetail {
  const count = (provenance: 'supplied' | 'observed') =>
    SPEC_FIELDS.filter((key) => completed[key]?.provenance === provenance).length;
  return captureDetail({
    input: analysis.product,
    output: completed,
    facts: {
      supplied: count('supplied'),
      observed: count('observed'),
      unspecified: SPEC_FIELDS.length - count('supplied') - count('observed'),
      warning,
    },
  });
}

/** "Front view produced in 92.1s." */
function producedMessage(candidate: Candidate): string {
  const view = VIEW_LABEL[candidate.view ?? 'front'];
  const latency = ((candidate.latencyMs ?? 0) / 1000).toFixed(1);
  return `${view[0].toUpperCase()}${view.slice(1)} view produced in ${latency}s.`;
}

function candidateDetail(
  candidate: Candidate,
  modelName: string,
  /** "Attempt 2 of 3", or "Regeneration 1, attempt 1 of 3". */
  attempt: string,
  settings: Record<string, string>,
): StageDetail {
  return captureDetail({
    // The keys, not the URLs: a presigned URL recorded here would be expired by the time
    // anyone read the log, and the key is what the pipeline itself passes around.
    input: {
      modelId: candidate.modelId,
      attempt: candidate.attempt,
      view: candidate.view,
      referenceKeys: candidate.referenceKeys,
      ...settings,
      prompt: candidate.prompt,
    },
    output: {
      candidateId: candidate.id,
      key: candidate.key,
      latencyMs: candidate.latencyMs,
      estimatedCostUsd: candidate.estimatedCostUsd,
    },
    facts: {
      model: modelName,
      attempt,
      view: candidate.view,
      inputs: candidate.referenceKeys?.length,
      ...settings,
      latencyMs: candidate.latencyMs,
      estimatedCostUsd: candidate.estimatedCostUsd,
    },
  });
}

/**
 * Only the mismatched attributes are kept. The full per-aspect list of an evaluation with many parts
 * runs past the snapshot budget, which would replace the whole verdict with its shape; the
 * complete list stays on the candidate.
 */
export function evaluationDetail(
  candidate: Candidate,
  spec: ProductSpec,
  verdict: Evaluation,
  attempt: number,
): StageDetail {
  const { attributes, ...rest } = verdict;
  const mismatches = attributes
    ?.filter((a) => a.outcome === 'mismatch')
    .map((a) => `${a.attribute}: ${a.expected} → ${a.observed}`);

  return captureDetail({
    input: { candidateId: candidate.id, attempt, judgedAgainst: spec },
    output: mismatches ? { ...rest, mismatches } : rest,
    facts: {
      verdict: verdict.verdict,
      reviewer: verdict.reviewer,
      sketchFidelity: verdict.scores.sketchFidelity,
      specAdherence: verdict.scores.specAdherence,
      imageQuality: verdict.scores.imageQuality,
      mismatched: attributes ? `${mismatches?.length ?? 0} of ${attributes.length}` : undefined,
    },
  });
}

/** The views of an attempt, each with its verdict, in one stage record. */
function evaluationsDetail(
  views: Candidate[],
  spec: ProductSpec,
  verdicts: Evaluation[],
  attempt: number,
): StageDetail {
  return captureDetail({
    input: { candidateIds: views.map((c) => c.id), attempt, judgedAgainst: spec },
    output: views.map((c, i) => ({
      view: c.view,
      ...(evaluationDetail(c, spec, verdicts[i], attempt).output as object),
    })),
    facts: {
      verdict: attemptVerdict(verdicts),
      ...Object.fromEntries(views.map((c, i) => [c.view ?? 'front', verdicts[i].verdict])),
    },
  });
}

/**
 * Candidates are appended by read-then-write rather than a DynamoDB list_append, because
 * this runs inside a step and only one step writes the list at a time: the front's step writes
 * its own candidate, the record step writes the other three together once their parallel
 * steps are done, so a reader never sees a partly recorded attempt and no two writers race.
 *
 * A step that fails after its write and before its checkpoint runs again with new ids, so the
 * entries of the same attempt and view are dropped first: a retry replaces its own earlier try
 * and never another call's entries.
 */
async function appendCandidates(rev: RevisionRef, added: Candidate[]): Promise<void> {
  const state = await getRevision(rev);
  if (!state) throw new Error(`revision ${rev.revisionId} disappeared`);
  const callOf = (c: Candidate) => `${c.attempt}:${c.view ?? 'front'}`;
  const replaced = new Set(added.map(callOf));
  await patchRevision(rev, {
    candidates: [...state.candidates.filter((c) => !replaced.has(callOf(c))), ...added],
  });
}

async function updateCandidates(
  rev: RevisionRef,
  deltas: Map<string, Partial<Candidate>>,
): Promise<void> {
  const state = await getRevision(rev);
  if (!state) throw new Error(`revision ${rev.revisionId} disappeared`);
  await patchRevision(rev, {
    candidates: state.candidates.map((c) => ({ ...c, ...deltas.get(c.id) })),
  });
}
