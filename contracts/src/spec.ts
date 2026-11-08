import type { ImageKind, ProductField, SketchAnalysis } from './analysis.js';
import type { ProductSpec, SpecField } from './pipeline.js';

import { normalise } from './vocab.js';

/** The views a sketch can draw, in the order the spec records them: the analyser's vocabulary. */
const SKETCH_VIEWS = ['front', 'back', 'side'] as const;

/**
 * Completes the product specification from the analysis alone.
 *
 * Pure, so the local runner and the deployed pipeline build the same spec from the same
 * analysis.
 *
 * Pure and synchronous — no clock, no randomness, no I/O — so it is safe inside a durable
 * step, where the same code is replayed and must return the same answer every time.
 *
 * There are no defaults. A field is either supplied (the analyser took it from the product
 * metadata), observed in the images, or absent. The metadata wins wherever it speaks; what the
 * images show fills only what it leaves unsaid:
 *
 * | field                 | supplied             | observed, only when                                     |
 * | --------------------- | -------------------- | ------------------------------------------------------- |
 * | `productType`         | `product.type`       | the analyser read it from the images                    |
 * | `colorDescription`    | `product.colour`     | no material sample; the colours a coloured image shows  |
 * | `materialDescription` | `product.material`   | no material sample; from the visible surface cues       |
 * | `dimensions`          | `product.dimensions` | never: a size cannot be measured on a drawing           |
 *
 * "Material sample" is the analyser's decision (`planImages`), passed in as `hasMaterial`.
 *
 * A material sample is the colour and material when the metadata does not name them, so nothing
 * observed in a sketch may compete with it.
 *
 * `views`, `parts`, `details`, `ignored` and `assumptions` are copied from the analysis for the
 * prompt, and `imageKinds` (what each input is) for generation and the critic.
 */
export function completeSpec(
  productId: string,
  analysis: SketchAnalysis,
  opts: { hasMaterial: boolean },
): ProductSpec {
  const spec: ProductSpec = { model: productId };
  const { product } = analysis;
  const supplied = (field: ProductField) =>
    product[field].source === 'metadata' ? specField(product[field].value, 'supplied') : undefined;
  const observed = (field: ProductField) =>
    product[field].source === 'image' ? specField(product[field].value, 'observed') : undefined;

  spec.productType = supplied('type') ?? observed('type');

  spec.colorDescription =
    supplied('colour') ?? (!opts.hasMaterial ? joined(analysis.observedColours) : undefined);

  spec.materialDescription =
    supplied('material') ?? (!opts.hasMaterial ? joined(analysis.materialCues) : undefined);

  spec.dimensions = supplied('dimensions');

  spec.views = SKETCH_VIEWS.filter((v) => analysis.views.includes(v));
  if (analysis.parts.length > 0) spec.parts = analysis.parts;
  if (analysis.details.length > 0) spec.details = analysis.details;
  if (analysis.ignored.length > 0) spec.ignored = analysis.ignored;
  if (analysis.assumptions.length > 0) spec.assumptions = analysis.assumptions;
  if (analysis.images) spec.imageKinds = analysis.images.map((i) => i.kind);

  // Drop absent keys, so a spec never carries `productType: undefined` into JSON and back.
  return Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined)) as ProductSpec;
}

/**
 * The run's warning for the reviewer: images not used as the analyser read them, a missing front
 * or back view, the analyser's assumptions, then one sentence per spec field nothing could fill.
 * `undefined` when there is nothing to say. Pure, like `completeSpec`.
 *
 * A missing side alone is not worth a warning: almost no sketch draws one. A material sample
 * stands for the colour and the material, so neither is a gap when one is given. Dimensions are
 * optional: the sketch's proportions stand without them.
 */
export function warningFor(spec: ProductSpec, opts: { hasMaterial: boolean }): string | undefined {
  const parts = [...imagesWarning(spec.imageKinds), viewsWarning(spec.views)];
  for (const assumption of spec.assumptions ?? []) parts.push(`Assumed: ${assumption}`);
  if (!spec.productType) parts.push('No product type found.');
  if (!spec.colorDescription && !opts.hasMaterial) parts.push('No colour found.');
  if (!spec.materialDescription && !opts.hasMaterial) parts.push('No material found.');
  const text = parts.filter(Boolean).join(' ');
  return text === '' ? undefined : text;
}

/** "image 2", "images 2 and 3", "images 2, 3 and 4". */
function imageList(numbers: number[]): string {
  const last = numbers.at(-1);
  return numbers.length === 1
    ? `image ${last}`
    : `images ${numbers.slice(0, -1).join(', ')} and ${last}`;
}

/** Extra material samples and unrelated images: what the analyser decided not to use as such. */
function imagesWarning(kinds: readonly ImageKind[] | undefined): string[] {
  if (!kinds) return [];
  const numbered = (kind: ImageKind) => kinds.flatMap((k, i) => (k === kind ? [i + 1] : []));
  const [material, ...extra] = numbered('material');
  const ignored = numbered('ignored');
  const sentences: string[] = [];
  if (extra.length > 0) {
    const list = imageList(extra);
    sentences.push(
      `Image ${material} is the material sample; ${list} ${extra.length > 1 ? 'are other material samples, sent as references' : 'is another material sample, sent as a reference'} only.`,
    );
  }
  if (ignored.length > 0) {
    const list = imageList(ignored);
    sentences.push(
      `${list[0].toUpperCase()}${list.slice(1)} ${ignored.length > 1 ? 'do' : 'does'} not show the product and ${ignored.length > 1 ? 'are' : 'is'} not used.`,
    );
  }
  return sentences;
}

/** "Only the front view is available; the back and the side will be assumed." */
function viewsWarning(views: ProductSpec['views']): string | undefined {
  if (!views || (views.includes('front') && views.includes('back'))) return undefined;
  const missing = SKETCH_VIEWS.filter((v) => !views.includes(v)).map((v) => `the ${v}`);
  const assumed = `${missing.slice(0, -1).join(', ')}${missing.length > 1 ? ' and ' : ''}${missing.at(-1)}`;
  if (views.length === 0)
    return `No front, back or side view is available; all three will be assumed.`;
  const shown = views.join(' and ');
  return `Only the ${shown} view${views.length > 1 ? 's are' : ' is'} available; ${assumed} will be assumed.`;
}

function specField(raw: string, provenance: SpecField['provenance']): SpecField {
  const value = normalise(raw);
  return value === raw ? { value, provenance } : { value, raw, provenance };
}

/** "navy", "navy and black", "navy, black and white". */
function joined(values: string[]): SpecField | undefined {
  const list = values.map((v) => v.trim()).filter(Boolean);
  if (list.length === 0) return undefined;
  const text = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  return specField(text, 'observed');
}
