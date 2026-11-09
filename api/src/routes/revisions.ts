import {
  InvokeCommand,
  LambdaClient,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import {
  CANDIDATE_VIEWS,
  MAX_REGENERATIONS,
  mayReadRevision,
  mayReviewRevision,
  pipelineInputSchema,
  reviewDecisionSchema,
  sanitizeReviewBody,
  sanitizeSubmitBody,
  submitRequestSchema,
  validatePackage,
  validateProductMetadata,
  type PipelineInput,
  type PipelineState,
  type ViewMap,
  type ViewUrls,
  type ProductMetadata,
  type ReviewDecision,
} from '@sketch-to-product-views/contracts';
import {
  createRevision,
  emit,
  etagFor,
  getReviewCallbackId,
  getRevision,
  isOwnedKey,
  presignDownload,
  type RevisionRef,
} from '@sketch-to-product-views/shared/store';
import { GuardrailBlockedError, screenText } from '@sketch-to-product-views/shared/guardrail';
import { deployedModel, findModel, selectParam } from '@sketch-to-product-views/shared/registry';
import { attemptBudgetFromEnv } from './models.js';
import {
  HttpError,
  badRequest,
  caller,
  fail,
  json,
  parseBody,
  type ApiEvent,
  type ApiResult,
} from '../http.js';

/**
 * The three revision routes: start a run, read it, resolve its review gate.
 *
 * This handler never runs a stage. Submit starts one durable execution and returns;
 * everything the UI later shows is written by that execution.
 */

let lambda: LambdaClient | undefined;
const lambdaClient = () => (lambda ??= new LambdaClient({}));

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

// `mayReadRevision` / `mayReviewRevision` live in `@sketch-to-product-views/contracts/src/authz.ts`.

export async function submit(event: ApiEvent): Promise<ApiResult> {
  // Resolved before anything is written: a request with no verified subject must not be
  // able to create a revision and emit rail events and only then be told it is a 401.
  const submittedBy = caller(event).sub;

  // Sanitised before any check, so the limits apply to the text the models will see.
  const parsed = submitRequestSchema.safeParse(sanitizeSubmitBody(parseBody(event)));
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;

  // Resolve the model here, not in the pipeline: an unknown id must be a 400 the user
  // sees immediately, not a durable execution that fails two stages in.
  const model = body.modelId
    ? findModel(body.modelId)
    : deployedModel('image-control', process.env.IMAGE_MODEL);
  if (!model) return fail(400, `modelId: unknown model "${body.modelId}"`);
  if (model.category !== 'image-control') {
    return fail(400, `modelId: ${model.id} is a ${model.category} model, not an image generator`);
  }

  // Each setting must be one the model's registry entry offers, or it would fail mid-run.
  for (const key of ['size', 'quality', 'complexity'] as const) {
    const value = body.settings?.[key];
    if (value === undefined) continue;
    if (!model.params.some((p) => p.key === key)) {
      return fail(400, `settings.${key}: ${model.id} has no ${key} setting`);
    }
    try {
      selectParam(model, key, value);
    } catch (error) {
      return fail(400, `settings.${key}: ${(error as Error).message}`);
    }
  }

  // The same functions the SPA ran before uploading. Re-run server-side because a client
  // check is a courtesy, not a control — and the metadata text goes into a model prompt.
  const { errors } = validatePackage(body.inputs);
  if (errors.length > 0) return fail(400, `inputs: ${errors.join(' ')}`);

  // Only keys under the caller's own prefix: a revision must not be able to point the
  // pipeline at another user's uploads, whose service role could read them.
  if (body.inputs.some((i) => !i.key || !isOwnedKey(submittedBy, i.key))) {
    return fail(400, 'inputs: a key is not one of your uploads.');
  }

  let productMetadata: ProductMetadata | undefined;
  if (body.productMetadata) {
    const checked = validateProductMetadata(body.productMetadata);
    if (!checked.ok) return fail(400, `productMetadata: ${checked.error.message}`);
    productMetadata = checked.metadata;
  }

  const revision = await startRevision({
    productId: body.productId,
    inputs: body.inputs,
    productMetadata,
    modelId: model.id,
    owner: submittedBy,
    ...(body.notes ? { requests: { notes: body.notes, reviewedBy: submittedBy } } : {}),
    ...(body.settings && Object.keys(body.settings).length > 0 ? { settings: body.settings } : {}),
  });

  return json(202, { revisionId: revision.revisionId });
}

export interface StartRevisionInput {
  productId: string;
  inputs: PipelineInput['inputs'];
  productMetadata?: ProductMetadata;
  /** A registry id the caller already resolved and checked. */
  modelId: string;
  /** The verified subject of the caller, never a body field. */
  owner: string;
  requests?: PipelineInput['requests'];
  settings?: PipelineInput['settings'];
}

/**
 * Creates the revision, records the upload and submit steps, and starts its durable execution.
 */
export async function startRevision(input: StartRevisionInput) {
  const revision = await createRevision({
    productId: input.productId,
    inputs: input.inputs,
    productMetadata: input.productMetadata,
    modelId: input.modelId,
    attemptBudget: input.settings?.attemptBudget ?? attemptBudgetFromEnv(),
    ...(input.settings ? { settings: input.settings } : {}),
    // From the verified claims, never from the body: this is what every later read and
    // review decision on this revision is authorized against.
    owner: input.owner,
  });

  // Upload and submit are already done by the time a submit lands: the bytes are in object storage
  // and the manifest is what this request carries. Recording them here rather than in the
  // pipeline keeps the rail honest — the UI shows what has happened, not what is planned.
  const ref = { owner: input.owner, revisionId: revision.revisionId };
  await emit(ref, 'upload', 'passed', {
    message: `${input.inputs.length} file(s) received.`,
  });
  await emit(ref, 'submit', 'passed', {
    message: `Revision ${revision.revision} manifest recorded.`,
  });

  // Parsed with the pipeline's own schema before it is sent: a payload the pipeline would
  // reject must fail here, naming the field, not as an execution that never starts.
  const payload = pipelineInputSchema.parse({
    revisionId: revision.revisionId,
    productId: input.productId,
    inputs: input.inputs,
    modelId: input.modelId,
    productMetadata: input.productMetadata,
    submittedBy: input.owner,
    // Lets the pipeline derive its artifact key prefix without re-reading the revision. It is
    // the stored value, so it is identical on every replay.
    createdAt: revision.createdAt,
    requests: input.requests,
    settings: input.settings,
  });

  await lambdaClient().send(
    new InvokeCommand({
      // Qualified: an unqualified invoke of a durable function is rejected outright.
      FunctionName: env('PIPELINE_ALIAS_ARN'),
      InvocationType: 'Event',
      // The revision id doubles as the execution name, so a retried submit joins the
      // existing execution instead of starting a second one over the same revision.
      DurableExecutionName: revision.revisionId,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  return revision;
}

/**
 * Polled by the SPA. Supports `If-None-Match`, so an idle run costs one 304 per interval
 * instead of a full document.
 */
export async function status(event: ApiEvent): Promise<ApiResult> {
  // Identity first, so an unauthenticated caller gets a 401 and never learns whether the
  // id exists.
  const reader = caller(event);

  const revisionId = event.pathParameters?.id;
  if (!revisionId) return fail(400, 'Missing revision id.');

  // Looked up under the caller's own key, so another user's revision is simply not found:
  // a 404 either way, and the route says nothing about which ids exist.
  const state = await getRevision({ owner: reader.sub, revisionId });
  if (!state) return fail(404, 'Unknown revision.');
  // Still checked: the key is the first boundary, this is the second.
  if (!mayReadRevision(state, reader.sub)) return fail(404, 'Unknown revision.');

  const etag = etagFor(state);
  const headers = { etag, 'cache-control': 'no-cache' };
  if (event.headers?.['if-none-match'] === etag) return { statusCode: 304, headers };

  return json(200, await hydrate(state), headers);
}

/**
 * Re-mints every artifact URL on read.
 *
 * The stored document holds keys, not URLs, because a presigned URL expires in an hour
 * and a review gate holds for up to seven days — a URL persisted at generation time would
 * be dead by the time a reviewer clicked it.
 */
async function hydrate(state: PipelineState): Promise<PipelineState> {
  const [inputs, candidates, deliveryUrl, deliveryUrls] = await Promise.all([
    Promise.all(
      state.inputs.map(async (i) => (i.key ? { ...i, url: await presignDownload(i.key) } : i)),
    ),
    Promise.all(
      state.candidates.map(async (c) => (c.key ? { ...c, url: await presignDownload(c.key) } : c)),
    ),
    state.deliveryKey ? presignDownload(state.deliveryKey) : Promise.resolve(state.deliveryUrl),
    state.deliveryKeys ? presignViews(state.deliveryKeys) : Promise.resolve(undefined),
  ]);

  return {
    ...state,
    inputs,
    candidates,
    ...(deliveryUrl ? { deliveryUrl } : {}),
    ...(deliveryUrls ? { deliveryUrls } : {}),
  };
}

/** One presigned URL per delivered view, whichever views the run delivered. */
async function presignViews(keys: ViewMap): Promise<ViewUrls> {
  const entries = await Promise.all(
    CANDIDATE_VIEWS.flatMap((view) => {
      const key = keys[view];
      return key ? [presignDownload(key).then((url) => [view, url] as const)] : [];
    }),
  );
  return Object.fromEntries(entries) as ViewUrls;
}

/**
 * Resolves the human review gate by completing the durable wait the pipeline parked on.
 *
 * The decision itself is not applied here — the pipeline reads the callback result and
 * decides what to do (deliver, regenerate, or fail). Keeping that logic in one place is
 * what stops the API and the pipeline disagreeing about the state of a run.
 */
export async function review(event: ApiEvent): Promise<ApiResult> {
  // The reviewer's name is recorded on the decision, so it is read from the verified
  // claims and never from the body — and read first, so an unauthenticated caller cannot
  // use this route to probe which revisions exist or which gate is open.
  const reviewer = caller(event);

  const revisionId = event.pathParameters?.id;
  if (!revisionId) return fail(400, 'Missing revision id.');

  const parsed = reviewDecisionSchema.safeParse(sanitizeReviewBody(parseBody(event)));
  if (!parsed.success) return badRequest(parsed.error);

  const ref = { owner: reviewer.sub, revisionId };
  const state = await getRevision(ref);
  if (!state) return fail(404, 'Unknown revision.');
  // Before the state-machine check, so a caller with no business here cannot learn whether
  // a gate is open on someone else's run.
  if (!mayReviewRevision(state, reviewer.sub)) return fail(403, 'Not your revision to review.');
  if (state.status !== 'awaiting_review') {
    return fail(409, 'This revision is not waiting for a review decision.');
  }

  const decision = parsed.data;
  // The pipeline delivers its own selection, so a decision about any other candidate is stale.
  if (decision.candidateId && decision.candidateId !== state.selectedCandidateId) {
    return fail(409, 'candidateId: these are no longer the views awaiting review.');
  }
  if (decision.decision === 'approve' && !candidateOf(state)) {
    return fail(400, 'candidateId: approve requires an existing candidate.');
  }
  if (
    decision.decision === 'regenerate' &&
    (state.regenerations?.length ?? 0) >= MAX_REGENERATIONS
  ) {
    return fail(409, `This run has used its ${MAX_REGENERATIONS} regenerations.`);
  }

  // Screened before the callback, so a blocked note is a 400 to fix, not a failed run.
  if (decision.decision === 'regenerate' && decision.notes) {
    try {
      await screenText([{ label: 'Review notes', text: decision.notes }]);
    } catch (error) {
      if (error instanceof GuardrailBlockedError) return fail(400, `notes: ${error.message}`);
      throw error;
    }
  }

  await resolveReviewGate(ref, decision, reviewer.name);

  return json(202, { ok: true });
}

/**
 * Completes the durable wait the pipeline parked on. The caller has already checked the
 * revision is `awaiting_review` and that this caller may decide.
 */
export async function resolveReviewGate(
  ref: RevisionRef,
  decision: ReviewDecision,
  reviewedBy: string,
): Promise<void> {
  const callbackId = await getReviewCallbackId(ref);
  if (!callbackId) {
    // The revision says it is waiting but no token was recorded. Reporting success here
    // would leave the run parked forever with the UI claiming it had been resolved.
    throw new HttpError(409, 'The review gate is not ready yet. Retry in a moment.');
  }

  await lambdaClient().send(
    new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: callbackId,
      Result: Buffer.from(
        JSON.stringify({ ...decision, reviewedBy, reviewedAt: new Date().toISOString() }),
      ),
    }),
  );
}

function candidateOf(state: PipelineState) {
  return state.candidates.find((c) => c.id === state.selectedCandidateId);
}
