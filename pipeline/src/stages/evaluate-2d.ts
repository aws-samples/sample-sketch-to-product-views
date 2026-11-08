import { planImages, type Candidate, type Evaluation, type ProductSpec } from '@sketch-to-product-views/contracts';
import type { Critic } from '@sketch-to-product-views/shared/qc/critic';
import { getArtifact, sniffImageType } from '@sketch-to-product-views/shared/store';
import type { PipelineInput } from '../input.js';

/**
 * Scores the candidate against the sketch (or a photo standing in for one), the material sample
 * and the specification, as the analyser picked the images.
 *
 * The images are read back from S3 rather than handed over by image generation, because a
 * durable step's result is checkpointed and image bytes have no business in a checkpoint
 * log. A few GETs are far cheaper than the quota they would otherwise consume.
 *
 * The critic fits each image to the model's limits with `sharp`, a native module, which is why
 * this function's deployment artifact is a directory rather than one bundled file — see
 * `pipeline/scripts/vendor-sharp.sh`.
 */
export async function evaluate2d(
  input: PipelineInput,
  spec: ProductSpec,
  candidate: Candidate,
  critic: Critic,
  modelId: string,
  /** After a regeneration: what was asked of this view, and the attributes that changes. */
  review: { requests?: readonly string[]; changed?: readonly string[] } = {},
): Promise<Evaluation> {
  // One reference: the first sketch, else the first photo, while the generator gets them all.
  const plan = planImages(input.inputs, spec.imageKinds);
  const front = plan.criticReference?.file;
  if (!front?.key) throw new Error('no sketch or photo available for evaluation');
  if (!candidate.key) throw new Error(`candidate ${candidate.id} has no stored image`);

  const swatchKey = plan.material?.key;

  const [sketch, image, swatch] = await Promise.all([
    getArtifact(front.key),
    getArtifact(candidate.key),
    swatchKey ? getArtifact(swatchKey) : undefined,
  ]);

  return critic.evaluate({
    sketch,
    sketchContentType: sniffImageType(sketch) ?? 'image/png',
    ...(plan.criticReference?.kind === 'photo' ? { sketchKind: 'photo' as const } : {}),
    candidate: image,
    candidateContentType: sniffImageType(image) ?? 'image/png',
    ...(swatch && { swatch, swatchContentType: sniffImageType(swatch) ?? 'image/png' }),
    spec,
    modelId,
    // The critic scores a back as a back: without it, a front detail it cannot see from
    // behind reads as missing.
    ...(candidate.view && { view: candidate.view }),
    ...(review.requests?.length ? { requests: review.requests } : {}),
    ...(review.changed?.length ? { changed: review.changed } : {}),
  });
}
