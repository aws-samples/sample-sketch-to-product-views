import { z } from 'zod';
import { STAGE_IDS, type StageId } from './stages.js';
import { MAX_IMAGES, inputRoleSchema } from './inputs.js';
import { productMetadataSchema } from './product-metadata.js';
import { IMAGE_KINDS, sketchAnalysisSchema } from './analysis.js';
import { CANDIDATE_VIEWS, attributeResultSchema, type CandidateView } from './attributes.js';

/**
 * Wire types shared by the API and the SPA. Nothing else crosses the
 * front/back boundary: the frontend never sees DynamoDB keys, S3 keys or AWS
 * SDK types, only what the API hands it here.
 */

export const stageIdSchema = z.enum(STAGE_IDS as unknown as [StageId, ...StageId[]]);

/** A stage is `awaiting_review` only when it is blocked on a human decision. */
export const stageStatusSchema = z.enum([
  'pending',
  'running',
  'passed',
  'failed',
  'awaiting_review',
  'skipped',
]);
export type StageStatus = z.infer<typeof stageStatusSchema>;

/**
 * What a stage was given and what it produced, recorded on the event that closes it.
 *
 * Lets the UI show the work, not just the verdict: for spec completion, the analysis in and the
 * specification with per-field provenance out; for package validation, the manifest and the
 * per-file check results; for the critic, the candidate and the scored verdict.
 *
 * **Snapshots, not payloads.** Whatever a stage records here is copied into the event log and
 * then re-sent on every poll of the run document, so it holds decisions, ids, keys and scores —
 * never image bytes and never a whole S3 object. `captureDetail` enforces a byte budget rather
 * than trusting callers, because the cost of getting this wrong is a document that grows until
 * polling it is slower than the pipeline it is reporting on.
 */
export const stageDetailSchema = z.object({
  /** The stage's own input, as JSON. Labelled "before" in the UI. */
  input: z.unknown().optional(),
  /** What the stage produced, as JSON. Labelled "after" in the UI. */
  output: z.unknown().optional(),
  /**
   * Scalar highlights worth reading without opening the JSON — a model id, a latency, a cost.
   * Kept flat and scalar on purpose: this renders as a definition list, not a tree.
   */
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Set when a snapshot was trimmed to fit the budget, so the UI never implies completeness. */
  truncated: z.boolean().optional(),
});
export type StageDetail = z.infer<typeof stageDetailSchema>;

/** Append-only log entry. The UI is a pure projection of these. */
export const stageEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  revisionId: z.string(),
  stage: stageIdSchema,
  status: stageStatusSchema,
  at: z.string(),
  /** Operator-facing sentence. Shown verbatim in the UI. */
  message: z.string().optional(),
  /** 1-based generation attempt this event belongs to. */
  attempt: z.number().int().positive().optional(),
  /** The view a per-view stage transition belongs to: 2D generation runs once per view. */
  view: z.enum(CANDIDATE_VIEWS).optional(),
  /** Set when a stage is implemented as a stub rather than real work. */
  stubbed: z.boolean().optional(),
  /**
   * The stage's input and output. Optional, and absent on `running` events by construction —
   * a stage has no output until it finishes. Also absent from any event written before this
   * field existed, which is why nothing may assume it is present.
   */
  detail: stageDetailSchema.optional(),
});
export type StageEvent = z.infer<typeof stageEventSchema>;

export const stageRunSchema = z.object({
  status: stageStatusSchema,
  attempt: z.number().int().nonnegative(),
  message: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  stubbed: z.boolean().optional(),
});
export type StageRun = z.infer<typeof stageRunSchema>;

/**
 * Where a specification value came from. `supplied`: the product metadata, as read by the
 * analyser and checked against the uploaded text. `observed`: the images. Nothing else exists —
 * there are no defaults, so a value that is neither is simply absent.
 */
export const provenanceSchema = z.enum(['supplied', 'observed']);
export type Provenance = z.infer<typeof provenanceSchema>;

export const specFieldSchema = z.object({
  /** Normalised (`contracts/src/vocab.ts`); what prompts use. */
  value: z.string(),
  /** As the analyser returned it, when normalisation changed it. Shown in the UI. */
  raw: z.string().optional(),
  provenance: provenanceSchema,
});
export type SpecField = z.infer<typeof specFieldSchema>;

/**
 * The product specification, built from the analysis alone (`completeSpec`). Every field is
 * optional: absent means unspecified, and the UI says so rather than showing a guess.
 */
export const productSpecSchema = z.object({
  /** The product id. */
  model: z.string(),
  /** What the object is, e.g. `lounge chair`. */
  productType: specFieldSchema.optional(),
  /** The material and its finish. */
  materialDescription: specFieldSchema.optional(),
  colorDescription: specFieldSchema.optional(),
  /** Always `supplied` when present: a size cannot be measured on a drawing. */
  dimensions: specFieldSchema.optional(),
  /**
   * The views the images show, in front, back, side order. Absent on a spec built before the
   * analyser reported them, and the prompt then assumes the sketch is the front.
   */
  views: z.array(z.enum(['front', 'back', 'side'])).optional(),
  /** The main parts the sketch draws, which make the object's shape. */
  parts: z
    .array(z.object({ name: z.string(), description: z.string(), location: z.string() }))
    .optional(),
  /** What the sketch draws that the image must keep: logos, prints, graphics, hardware, trims. */
  details: z
    .array(
      z.object({
        description: z.string(),
        location: z.string(),
        view: z.enum(['front', 'back', 'side']),
      }),
    )
    .optional(),
  /** Marks on the images that are not the product, which the image leaves out. */
  ignored: z.array(z.string()).optional(),
  /** The analyser's decisions where the inputs left something open, passed to the prompt. */
  assumptions: z.array(z.string()).optional(),
  /**
   * What the analyser read each input as, in input order: which images are design references and
   * which is the material sample. Absent on a run analysed before images were classified, whose
   * input roles decide (`planImages`).
   */
  imageKinds: z.array(z.enum(IMAGE_KINDS)).optional(),
});
export type ProductSpec = z.infer<typeof productSpecSchema>;

export const SPEC_FIELDS = [
  'productType',
  'materialDescription',
  'colorDescription',
  'dimensions',
] as const;
export type SpecFieldKey = (typeof SPEC_FIELDS)[number];

/**
 * Which model actually ran, recorded by the stage that ran it.
 *
 * Resolved from the registry at call time and written to the run, never derived in the UI:
 * the registry's default changes whenever a model is swapped, so reading it at display time
 * would relabel every past run with whatever is current. This is the audit answer to "what
 * produced this image", and the reason a swap needs no UI change.
 */
export const modelUseSchema = z.object({
  /** Registry entry id, e.g. `gpt-image-flare`. */
  id: z.string(),
  /** Human name from the registry, e.g. `Stable Image Control Sketch`. */
  name: z.string(),
  /** The id actually passed to Bedrock — a model id or a geo inference profile. */
  bedrockModelId: z.string(),
  /** Region whose endpoint served the call. */
  region: z.string(),
});
export type ModelUse = z.infer<typeof modelUseSchema>;

/** The critic's verdict. */
export const evaluationSchema = z.object({
  verdict: z.enum(['pass', 'warn', 'fail']),
  scores: z.object({
    sketchFidelity: z.number().min(0).max(1),
    specAdherence: z.number().min(0).max(1),
    imageQuality: z.number().min(0).max(1),
  }),
  issues: z.array(z.string()),
  /** Which reviewer produced this, e.g. `judge`. */
  reviewer: z.string(),
  /**
   * The critic model. Optional so an evaluation recorded without one still parses.
   */
  model: modelUseSchema.optional(),
  /** Per-attribute outcomes, when the reviewer works attribute by attribute. */
  attributes: z.array(attributeResultSchema).optional(),
  /**
   * Set when a first reading would have failed the view and a second one was asked:
   * `failedOn` what the first failed on, `confirmed` what the second agreed on. Only a
   * confirmed fact fails.
   */
  confirmation: z
    .object({ failedOn: z.array(z.string()), confirmed: z.array(z.string()) })
    .optional(),
});
export type Evaluation = z.infer<typeof evaluationSchema>;

export const candidateSchema = z.object({
  id: z.string(),
  /** Re-minted on every read; see `inputFileSchema.url`. */
  url: z.string(),
  /** Storage handle, so the URL above can be re-minted. See `inputFileSchema.key`. */
  key: z.string().max(1024).optional(),
  /** Registry entry id. `model` carries the rest, for runs written since it was added. */
  modelId: z.string(),
  /** The generator that produced this image, as resolved for this attempt. */
  model: modelUseSchema.optional(),
  attempt: z.number().int().positive(),
  createdAt: z.string(),
  prompt: z.string().optional(),
  evaluation: evaluationSchema.optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  /**
   * Which view of the product this image shows. Each view of an attempt is its own call and
   * its own image; the views of one attempt share its `attempt`. A run written before views
   * existed has none, and shows a front.
   */
  view: z.enum(CANDIDATE_VIEWS).optional(),
  /**
   * Storage handles of the images the call was given, in the order they were sent: the design
   * references, the material sample, the front render, or the renders alone. What makes a view
   * reproducible.
   */
  referenceKeys: z.array(z.string().max(1024)).optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

/**
 * One value per generated view, the front required. Written out rather than derived from
 * `CANDIDATE_VIEWS` so the type stays literal; `contracts/test/views.test.ts` checks the two agree.
 */
const perView = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    front: value,
    back: value.optional(),
    left: value.optional(),
    right: value.optional(),
  });

/** One candidate id or storage key per view of the accepted attempt. */
export const viewMapSchema = perView(z.string().max(1024));
export type ViewMap = z.infer<typeof viewMapSchema>;

/** One presigned URL per delivered view; longer than a key, so no length cap. */
export const viewUrlsSchema = perView(z.string());
export type ViewUrls = z.infer<typeof viewUrlsSchema>;

/** A reviewer's request, rewritten for the image model of one view. */
export const viewRequestSchema = z.object({
  view: z.enum(CANDIDATE_VIEWS),
  request: z.string().min(1),
});
export type ViewRequest = z.infer<typeof viewRequestSchema>;

/**
 * One regeneration a reviewer asked for: their description, and the views it was routed to.
 * `views` lists only what the description asks for; the views made from a remade view are
 * remade with it (`viewsToRemake`).
 */
export const regenerationSchema = z.object({
  /** 1-based: the first regeneration is round 1. */
  round: z.number().int().positive(),
  notes: z.string(),
  views: z.array(viewRequestSchema),
  /**
   * The critic's aspects the description changes (`color`, `parts`), which the critic then
   * stops taking from the sketch: the reviewer asked to depart from it there. Absent on a
   * regeneration recorded before the critic was given the description.
   */
  attributes: z.array(z.string()).optional(),
  reviewedBy: z.string().optional(),
});
export type Regeneration = z.infer<typeof regenerationSchema>;

/**
 * How many times a reviewer may send a run back to 2D generation. Each round spends up to the
 * attempt budget again, four image calls per attempt.
 */
export const MAX_REGENERATIONS = 3;

/**
 * The views to remake when these are asked for: each view is made from the ones before it, so
 * a new front remakes all four and a new back remakes both profiles. In view order.
 */
export function viewsToRemake(asked: Iterable<CandidateView>): CandidateView[] {
  const set = new Set(asked);
  const front = set.has('front');
  const back = front || set.has('back');
  return CANDIDATE_VIEWS.filter((view) =>
    view === 'front' ? front : view === 'back' ? back : back || set.has(view),
  );
}

/** Every attribute a regeneration changed, in the order first changed. */
export function changedAttributes(
  regenerations: readonly Pick<Regeneration, 'attributes'>[],
): string[] {
  return [...new Set(regenerations.flatMap((r) => r.attributes ?? []))];
}

/**
 * Every request a view was given across the regenerations, oldest first. A view remade later
 * for another reason is given them all again, or the new image would undo them.
 */
export function requestsByView(
  regenerations: readonly Pick<Regeneration, 'views'>[],
): Partial<Record<CandidateView, string[]>> {
  const byView: Partial<Record<CandidateView, string[]>> = {};
  for (const { views } of regenerations) {
    for (const { view, request } of views) (byView[view] ??= []).push(request);
  }
  return byView;
}

/**
 * What the critic made of the selected attempt. `approved: false` when every attempt of the loop
 * was rejected and the run kept the best one for the reviewer instead of failing.
 */
export const criticVerdictSchema = z.object({
  approved: z.boolean(),
  /** The selected attempt, numbered as `Candidate.attempt`. */
  attempt: z.number().int().positive(),
  /** How many attempts the loop made before it stopped. */
  attempts: z.number().int().positive(),
  /** The critic's main issues with the selected views, deduplicated; empty when approved. */
  issues: z.array(z.string()),
});

/**
 * The selected attempt is a regeneration, which the critic does not score: it neither approved
 * nor rejected it. Written over the outcome of an earlier round of the same run.
 */
export const criticSkippedSchema = z.object({
  evaluated: z.literal(false),
  /** The selected attempt, numbered as `Candidate.attempt`. */
  attempt: z.number().int().positive(),
});

export const criticOutcomeSchema = z.union([criticVerdictSchema, criticSkippedSchema]);
export type CriticOutcome = z.infer<typeof criticOutcomeSchema>;

export const revisionStatusSchema = z.enum([
  'running',
  'awaiting_review',
  'approved',
  'failed',
  'cancelled',
]);
export type RevisionStatus = z.infer<typeof revisionStatusSchema>;

export const inputFileSchema = z.object({
  /** Absent means a plain image; `swatch` is a hint from an older client (`./inputs.ts`). */
  role: inputRoleSchema.optional(),
  filename: z.string(),
  /**
   * Displayable URL. The deployed API mints this fresh on every read, because a
   * presigned URL outlives neither a 7-day review nor a browser left open overnight.
   */
  url: z.string(),
  /**
   * Storage handle for the same object, echoed back from the presign response.
   * `url` is a view; this is the identity — the pipeline reads bytes by this, never by
   * following a URL that may already have expired.
   */
  key: z.string().max(1024).optional(),
});
export type InputFile = z.infer<typeof inputFileSchema>;

/** Most generation attempts a run may ask for before review. */
export const MAX_ATTEMPT_BUDGET = 4;

/**
 * Per-run image settings, chosen on the start form. Size, quality and complexity are GPT Image
 * parameters; the API checks each against the chosen model's registry options.
 */
export const generationSettingsSchema = z
  .object({
    size: z.string().min(1).max(32).optional(),
    quality: z.string().min(1).max(32).optional(),
    complexity: z.string().min(1).max(32).optional(),
    attemptBudget: z.number().int().min(1).max(MAX_ATTEMPT_BUDGET).optional(),
  })
  .strict();
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

/** The one document the SPA polls. Everything on screen comes from here. */
export const pipelineStateSchema = z.object({
  revisionId: z.string(),
  productId: z.string(),
  /**
   * Display-only revision ordinal, always `1` today.
   *
   * Kept rather than removed: the SPA renders it (`web/src/App.tsx`) and it is written on
   * every stored revision, so dropping it is a breaking contract change for no gain. It no
   * longer has any role in storage — artifact keys are prefixed by `revisionSegment`
   * (`createdAt` + `revisionId`), not by this number — so nothing may key off it. It becomes
   * meaningful only when re-submitting a product creates revision 2 of the same lineage.
   */
  revision: z.number().int().positive(),
  status: revisionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Subject (`sub`) of the verified JWT that submitted this revision. Written once, at
   * creation, from the claims and never from a request body — it is the only thing the
   * per-revision authorization check has to go on. It also prefixes every key the revision
   * lives under, so a revision cannot exist without one.
   */
  owner: z.string().min(1),
  /** Image model used for 2D generation, resolved from the registry at submit time. */
  modelId: z.string(),
  attemptBudget: z.number().int().positive(),
  /** The settings the run was submitted with; absent when it used the defaults. */
  settings: generationSettingsSchema.optional(),
  attempt: z.number().int().nonnegative(),
  inputs: z.array(inputFileSchema),
  /** As submitted, verbatim. Read only by the analyser; shown in the UI next to the spec. */
  productMetadata: productMetadataSchema.optional(),
  /** The analyser's output. Absent until it has run. */
  analysis: sketchAnalysisSchema.optional(),
  /** The product specification, built from `analysis` alone. */
  spec: productSpecSchema.optional(),
  /** The run's warning for the reviewer, set when the spec is built. */
  warning: z.string().optional(),
  stages: z.partialRecord(stageIdSchema, stageRunSchema),
  candidates: z.array(candidateSchema),
  /** The front of the accepted attempt: what review reads. */
  selectedCandidateId: z.string().optional(),
  /** Every view of the accepted attempt, the front included. */
  selectedViews: viewMapSchema.optional(),
  /** Written with the selection. Absent on a run selected before it existed. */
  criticOutcome: criticOutcomeSchema.optional(),
  /** Each regeneration a reviewer asked for, oldest first. Absent until the first one. */
  regenerations: z.array(regenerationSchema).optional(),
  /**
   * The design team's notes on a first generation (`PipelineInput.requests`),
   * routed to the views like a regeneration's. Every later image of a view is given them too.
   */
  guidance: regenerationSchema.omit({ round: true }).optional(),
  /** Set when the run ended in `failed`, so the UI can state why. */
  failureReason: z.string().optional(),
  deliveryUrl: z.string().optional(),
  /** Storage handle behind `deliveryUrl`, so that URL can be re-minted on read. The front. */
  deliveryKey: z.string().max(1024).optional(),
  /** Storage handle of every delivered view, the front included. */
  deliveryKeys: viewMapSchema.optional(),
  /** Re-minted on read from `deliveryKeys`, like `deliveryUrl` from `deliveryKey`. */
  deliveryUrls: viewUrlsSchema.optional(),
  events: z.array(stageEventSchema),
});
export type PipelineState = z.infer<typeof pipelineStateSchema>;

// ── Requests ────────────────────────────────────────────────────────────────

export const submitRequestSchema = z.object({
  productId: z.string().min(1).max(64),
  /** Per-file shape is checked here; how many is a package rule, in `validatePackage`. */
  inputs: z.array(inputFileSchema).min(1).max(MAX_IMAGES),
  /** Whatever the business knows, in any shape. Optional; see `./product-metadata.ts`. */
  productMetadata: productMetadataSchema.optional(),
  /** Optional override; falls back to the registry default image model. */
  modelId: z.string().max(128).optional(),
  /** Optional design notes; the pipeline routes them to the views they concern. */
  notes: z.string().trim().min(1).max(4000).optional(),
  /** Optional; unset fields fall back to the deployment, then the registry defaults. */
  settings: generationSettingsSchema.optional(),
});
export type SubmitRequest = z.infer<typeof submitRequestSchema>;

/**
 * The payload the API invokes the durable pipeline with.
 *
 * Here rather than in the pipeline so the API builds it against the same schema the pipeline
 * parses it with. Validated rather than trusted even though the only caller is our own API: an
 * execution that starts on a malformed payload fails in the middle of the rail with a type
 * error, which is far harder to read than a rejection at the entry point.
 */
export const pipelineInputSchema = z.object({
  revisionId: z.string().min(1),
  productId: z.string().min(1),
  inputs: z.array(inputFileSchema).min(1),
  productMetadata: productMetadataSchema.optional(),
  /** Registry id, already resolved and validated by the API. */
  modelId: z.string().min(1),
  /** The owner's `sub`: the pipeline builds every revision and artifact key from it. */
  submittedBy: z.string().min(1),
  /** The revision's stored `createdAt`, from which the artifact key prefix is derived. */
  createdAt: z.string().min(1),
  /** The design team's notes, which guide the first generation. */
  requests: z
    .object({
      notes: z.string().trim().min(1).max(4000),
      reviewedBy: z.string().optional(),
    })
    .optional(),
  /** Already checked against the model's options by the API. */
  settings: generationSettingsSchema.optional(),
});
export type PipelineInput = z.infer<typeof pipelineInputSchema>;

/**
 * A regeneration carries the reviewer's description of what to change: the pipeline routes it
 * to the views it concerns, and without it would only repeat the same images.
 */
export const reviewDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'regenerate']),
    candidateId: z.string().optional(),
    notes: z.string().max(4000).optional(),
  })
  .refine((d) => d.decision !== 'regenerate' || Boolean(d.notes?.trim()), {
    path: ['notes'],
    message: 'regenerate needs a description of what to change',
  });
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const presignRequestSchema = z.object({
  productId: z.string().min(1).max(64),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128),
  sizeBytes: z.number().int().positive(),
  /** Ignored; accepted so an older client's request still parses. */
  role: inputRoleSchema.optional(),
});
export type PresignRequest = z.infer<typeof presignRequestSchema>;

export const presignResponseSchema = z.object({
  uploadUrl: z.string(),
  key: z.string(),
  cdnUrl: z.string(),
  contentType: z.string(),
});
export type PresignResponse = z.infer<typeof presignResponseSchema>;
