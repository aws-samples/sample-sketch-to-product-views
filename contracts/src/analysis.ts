import { z } from 'zod';

/**
 * The analyser's output: what the analyser model reads from the images and the product
 * metadata together. It is the only source of the product specification — nothing downstream
 * reads the metadata itself.
 *
 * Two representations of one schema:
 *
 *  - `SKETCH_ANALYSIS_JSON_SCHEMA`, hand-written, is what Bedrock constrains the model with. It
 *    keeps to the subset structured outputs support: `additionalProperties: false` on every
 *    object, no length or numeric bounds, no recursion, no `anyOf`
 *    (https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html). "Not
 *    identified" is therefore `source: "none"` rather than a nullable field.
 *  - `rawAnalysisSchema`, its zod mirror, is what the response is parsed with. Bedrock's
 *    constraint is a promise from a remote service; the parse is the check.
 *
 * `checkAnalysis` then applies what neither can express: no dimensions read from the images,
 * each view listed once, and the images in order. Values are not compared with the metadata: its
 * format is open, and the analyser may legitimately rephrase it.
 *
 * The analyser also decides what each uploaded image is (`images`): a sketch or a photo of the
 * product (a design reference, with the views it shows), a material sample, or unrelated.
 *
 * Every field feeds the image prompt; nothing is read only for its own sake.
 */

const viewKinds = ['front', 'back', 'side'] as const;
const sources = ['metadata', 'image', 'none'] as const;

/** `type`: what the object is ("lounge chair", "running shoe"). `dimensions`: metadata only. */
export const PRODUCT_FIELDS = ['type', 'colour', 'material', 'dimensions'] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

const productFieldSchema = z.object({ value: z.string(), source: z.enum(sources) });

/**
 * What an uploaded image is. `sketch`: a design drawing of the product. `photo`: a photo or
 * render of the product or a prototype. Both are design references. `material`: a sample of a
 * material, finish or colour. `ignored`: unrelated to the product.
 */
export const IMAGE_KINDS = ['sketch', 'photo', 'material', 'ignored'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const IMAGE_KIND_LABELS: Record<ImageKind, string> = {
  sketch: 'Sketch',
  photo: 'Photo',
  material: 'Material sample',
  ignored: 'Not used',
};

/** The analyser's reading of one uploaded image. */
export const imageReadingSchema = z.object({
  /** 1-based, as numbered in the request: the upload order. */
  image: z.number().int(),
  kind: z.enum(IMAGE_KINDS),
  /** The views of the product the image shows; empty for a material or an ignored image. */
  views: z.array(z.enum(viewKinds)),
  /** What the image shows, in a few words. */
  description: z.string(),
});
export type ImageReading = z.infer<typeof imageReadingSchema>;

export const rawAnalysisSchema = z.object({
  product: z.object({
    type: productFieldSchema,
    colour: productFieldSchema,
    material: productFieldSchema,
    dimensions: productFieldSchema,
  }),
  /** One entry per uploaded image. */
  images: z.array(imageReadingSchema),
  /** The main parts that make the object's shape and construction. */
  parts: z.array(z.object({ name: z.string(), description: z.string(), location: z.string() })),
  /** Logos, prints, graphics, hardware and trims the image model must keep. */
  details: z.array(
    z.object({ description: z.string(), location: z.string(), view: z.enum(viewKinds) }),
  ),
  /** Marks that are not the product: notes, codes, signatures, other objects, figures. */
  ignored: z.array(z.string()),
  observedColours: z.array(z.string()),
  materialCues: z.array(z.string()),
  /**
   * What the analyser decided where the inputs leave something open (which colour goes where,
   * which object is the product), each a plain sentence. Shown to the reviewer and sent to the
   * image model. Empty means nothing was open.
   */
  assumptions: z.array(z.string()),
});
export type RawAnalysis = z.infer<typeof rawAnalysisSchema>;

/**
 * What is stored on the revision, after `checkAnalysis`: the raw output in image order, plus
 * `views`, every view the design references show. `images` is absent on a run analysed before
 * the analyser classified the images.
 */
export const sketchAnalysisSchema = rawAnalysisSchema.extend({
  images: z.array(imageReadingSchema).optional(),
  views: z.array(z.enum(viewKinds)),
});
export type SketchAnalysis = z.infer<typeof sketchAnalysisSchema>;

// ── JSON Schema sent to Bedrock ─────────────────────────────────────────────

const str = { type: 'string' } as const;
const strings = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const productField = obj({ value: str, source: { type: 'string', enum: [...sources] } });

export const SKETCH_ANALYSIS_JSON_SCHEMA = obj({
  product: obj(Object.fromEntries(PRODUCT_FIELDS.map((f) => [f, productField]))),
  images: {
    type: 'array',
    items: obj({
      image: { type: 'integer' },
      kind: { type: 'string', enum: [...IMAGE_KINDS] },
      views: { type: 'array', items: { type: 'string', enum: [...viewKinds] } },
      description: str,
    }),
  },
  parts: { type: 'array', items: obj({ name: str, description: str, location: str }) },
  details: {
    type: 'array',
    items: obj({ description: str, location: str, view: { type: 'string', enum: [...viewKinds] } }),
  },
  ignored: strings,
  observedColours: strings,
  materialCues: strings,
  assumptions: strings,
});

// ── Checks beyond the schema ────────────────────────────────────────────────

const NONE = { value: '', source: 'none' } as const;

/** The kinds that show the product itself: what generation and the critic design from. */
export const DESIGN_KINDS: readonly ImageKind[] = ['sketch', 'photo'];

/**
 * Why the image list does not describe the `count` images sent, or undefined when it does: each
 * image read exactly once, by its number.
 */
export function imagesIssue(raw: Pick<RawAnalysis, 'images'>, count: number): string | undefined {
  const numbers = raw.images.map((i) => i.image).sort((a, b) => a - b);
  const expected = Array.from({ length: count }, (_, i) => i + 1);
  return numbers.join() === expected.join()
    ? undefined
    : `images lists ${numbers.join(', ') || 'none'}, not each of 1 to ${count} once`;
}

/**
 * The reason the analysis cannot be designed from, or undefined: no image is a sketch or a photo
 * of the product. Shown to the person who submitted, so it says what each image was read as.
 */
export function noDesignReference(analysis: Pick<SketchAnalysis, 'images'>): string | undefined {
  const images = analysis.images;
  if (!images || images.some((i) => DESIGN_KINDS.includes(i.kind))) return undefined;
  const read = images.map(
    (i) => `image ${i.image} as ${i.kind === 'ignored' ? 'unrelated' : 'a material sample'}`,
  );
  return `No image is a sketch or a photo of the product (the analyser read ${read.join(', ')}). Add a sketch or a photo of the product.`;
}

/**
 * Applies the rules the schema cannot, in code, so they hold whatever the model does.
 *
 * Dimensions read from the images become `none`: a size cannot be measured on a drawing. The
 * images are put in order; a material or an ignored image shows no view. `views` is every view
 * the sketches and photos show, each once. Every string is trimmed, never cut, and empty list
 * entries go, a part without a name or a detail without a description with them.
 */
export function checkAnalysis(raw: RawAnalysis): SketchAnalysis {
  const product = {} as SketchAnalysis['product'];
  for (const field of PRODUCT_FIELDS) {
    const claimed = raw.product[field];
    const value = claimed.value.trim();
    const metadataOnly = field === 'dimensions' && claimed.source === 'image';
    product[field] =
      claimed.source === 'none' || value === '' || metadataOnly
        ? NONE
        : { value, source: claimed.source };
  }

  const trimAll = (list: string[]) => list.map((t) => t.trim()).filter(Boolean);
  const images = [...raw.images]
    .sort((a, b) => a.image - b.image)
    .map((i) => ({
      ...i,
      views: DESIGN_KINDS.includes(i.kind) ? [...new Set(i.views)] : [],
      description: i.description.trim(),
    }));

  return {
    ...raw,
    product,
    images,
    views: [...new Set(images.flatMap((i) => i.views))],
    parts: raw.parts
      .map((p) => ({
        name: p.name.trim(),
        description: p.description.trim(),
        location: p.location.trim(),
      }))
      .filter((p) => p.name),
    details: raw.details
      .map((d) => ({ ...d, description: d.description.trim(), location: d.location.trim() }))
      .filter((d) => d.description),
    ignored: trimAll(raw.ignored),
    observedColours: trimAll(raw.observedColours),
    materialCues: trimAll(raw.materialCues),
    assumptions: trimAll(raw.assumptions),
  };
}
