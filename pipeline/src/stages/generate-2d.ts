import { randomUUID } from 'node:crypto';
import {
  planImages,
  type Candidate,
  type CandidateView,
  type ProductSpec,
} from '@sketch-to-product-views/contracts';
import { planViewCall, viewInputs, type ImageGenerator } from '@sketch-to-product-views/shared/generate';
import { modelById, modelUse } from '@sketch-to-product-views/shared/registry';
import { candidateKey, getArtifact, putArtifact } from '@sketch-to-product-views/shared/store';
import type { PipelineInput } from '../input.js';

/**
 * Generates one view of the product: one model call, one image, one candidate.
 *
 * The front is made from the design references and the material sample, as the analyser picked
 * them (`planImages`). The other views are made from the front render, with those attached again
 * only when the sketch draws that view (`planViewCall`). Every view of an attempt is rendered at the same size and quality, which
 * the handler resolves once from the registry and the deployment.
 *
 * Everything provider-specific is behind `ImageGenerator` and the registry, so this file
 * contains no provider concepts — which is what makes swapping the image model a `-var`
 * rather than an edit here.
 *
 * The prompt and the keys of the images sent are stored on the candidate. A candidate whose
 * inputs are not recorded cannot be explained or reproduced, and explaining why an image came
 * out wrong is the entire purpose of the review stage.
 *
 * Returns only the candidate — deliberately no image bytes. A durable step's return value
 * is persisted to the checkpoint log, which has a hard 100 MB budget for the whole
 * execution, so a few megabytes of PNG per view would spend a shared, un-raisable quota
 * on data that is already durably stored in S3. The critic and the other views re-read it by key.
 */
export async function generateView(
  input: PipelineInput,
  spec: ProductSpec,
  attempt: number,
  view: CandidateView,
  generator: ImageGenerator,
  /** The run's artifact prefix, from `revisionSegment`. Resolved once by the handler. */
  revSegment: string,
  opts: {
    /** The size and quality of every view of the attempt, from `imageSettings`. */
    settings: Record<string, string>;
    /** This attempt's front, which every other view is made from. */
    front?: Candidate;
    /** This attempt's back, which the profiles are made from along with the front. */
    back?: Candidate;
    /** What the critic found on this view's previous image, when it was rejected. */
    corrections?: string[];
    /** What the design team asked to change on this view, every regeneration so far. */
    requests?: string[];
  },
): Promise<Candidate> {
  const plan = planImages(input.inputs, spec.imageKinds);
  // The sketches and photos in upload order, then any further material samples as references.
  const images = [...plan.design, ...plan.extraMaterials].flatMap((i) => (i.key ? [i.key] : []));
  // The analyser has already proved one exists; failing loudly here rather than with a
  // `undefined.key` further down keeps the cause readable in the log.
  if (plan.design.length === 0) throw new Error('no sketch or photo available for generation');
  if (view !== 'front' && !opts.front?.key) {
    throw new Error(`the ${view} view needs the front render and none was given`);
  }

  const entry = modelById(input.modelId);
  // The material sample, when there is one and the model takes it: the only input that shows the
  // pattern (a check, a stripe) a colour name such as NAVY/DARK GREEN stands for.
  const swatchKey = entry.acceptsInputs.includes('swatch') ? plan.material?.key : undefined;

  const call = planViewCall(view, spec, {
    hasSwatch: Boolean(swatchKey),
    corrections: opts.corrections,
    requests: opts.requests,
    sketchImages: images.length,
    materialReferences: plan.extraMaterials.length,
    designKinds: plan.designKinds,
  });
  const referenceKeys = viewInputs(call.inputs, {
    // Every design reference, in upload order: a back drawn on its own file is the only drawing
    // of the back.
    sketch: images,
    swatch: swatchKey,
    front_render: opts.front?.key,
    back_render: opts.back?.key,
  });
  const [first, ...references] = await Promise.all(referenceKeys.map((key) => getArtifact(key)));

  const result = await generator.generate({
    modelId: entry.id,
    prompt: call.prompt,
    sketch: first,
    ...(references.length > 0 ? { references } : {}),
    params: opts.settings,
  });

  const id = randomUUID();
  const key = candidateKey(input.submittedBy, input.productId, revSegment, id, result.contentType);
  await putArtifact(key, result.image, result.contentType);
  return {
    id,
    // Left empty on purpose: the API re-mints a presigned URL from `key` on every read,
    // because a URL stored here would expire long before a reviewer opened it.
    url: '',
    key,
    modelId: entry.id,
    model: modelUse(entry),
    attempt,
    createdAt: new Date().toISOString(),
    prompt: call.prompt,
    view,
    referenceKeys,
    ...(entry.costPerCall !== undefined ? { estimatedCostUsd: entry.costPerCall } : {}),
    latencyMs: result.durationMs,
  } satisfies Candidate;
}
