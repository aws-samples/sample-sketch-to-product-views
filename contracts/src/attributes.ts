import { z } from 'zod';

/**
 * The aspects the critic compares between a sketch and a generated view, for any sketched
 * object. `docs/evaluation/attribute-schema.csv` is the copy reviewers read;
 * `contracts/test/attributes.test.ts` keeps the two aligned.
 */

/** `spec`: a supplied product fact. `swatch`: the material sample. */
export const ATTRIBUTE_SOURCES = ['spec', 'sketch', 'swatch', 'convention'] as const;
export type AttributeSource = (typeof ATTRIBUTE_SOURCES)[number];

export const ATTRIBUTE_WEIGHTS = ['must', 'should', 'nice'] as const;
export type AttributeWeight = (typeof ATTRIBUTE_WEIGHTS)[number];

/** A model answers this when an image does not show an aspect. */
export const NOT_VISIBLE = 'not_visible';

export interface AspectDef {
  name: string;
  /** What the aspect covers, as the critic's prompt says it. */
  label: string;
  /** What it is compared with. */
  sources: readonly AttributeSource[];
  weight: AttributeWeight;
  /** A confirmed difference fails the view; any other difference only warns. */
  hard: boolean;
  /** Answered once per part the sketch draws, not once for the object. */
  perPart?: boolean;
}

export const ASPECTS = [
  {
    name: 'object_type',
    label: 'what the object is',
    sources: ['sketch', 'spec'],
    weight: 'must',
    hard: true,
  },
  {
    name: 'shape',
    label: 'the overall shape and silhouette',
    sources: ['sketch'],
    weight: 'must',
    hard: false,
  },
  {
    name: 'proportions',
    label: 'the relative size of the main parts',
    sources: ['sketch'],
    weight: 'should',
    hard: false,
  },
  {
    name: 'parts',
    label: 'each part or detail the sketch draws',
    sources: ['sketch'],
    weight: 'should',
    hard: false,
    perPart: true,
  },
  {
    name: 'color',
    label: 'the dominant colour',
    sources: ['spec', 'swatch'],
    weight: 'must',
    hard: true,
  },
  {
    name: 'material',
    label: 'the material and its finish',
    sources: ['spec', 'swatch'],
    weight: 'should',
    hard: false,
  },
  {
    name: 'pattern',
    label: 'patterns, graphics and text on the surface',
    sources: ['sketch', 'swatch'],
    weight: 'should',
    hard: false,
  },
  {
    name: 'presentation',
    label: 'a usable studio product image',
    sources: ['convention'],
    weight: 'must',
    hard: true,
  },
] as const satisfies readonly AspectDef[];

export type AspectName = (typeof ASPECTS)[number]['name'];

export function aspectDef(name: string): AspectDef {
  const def = (ASPECTS as readonly AspectDef[]).find((a) => a.name === name);
  if (!def) throw new Error(`unknown aspect ${name}`);
  return def;
}

/** Drawn on the sketch: scored under `sketchFidelity`. */
export function isSketchSourced(def: AspectDef): boolean {
  return def.sources.includes('sketch');
}

/** Stated by a supplied fact or the material sample: scored under `specAdherence`. */
export function isSpecSourced(def: AspectDef): boolean {
  return def.sources.some((s) => s === 'spec' || s === 'swatch');
}

/**
 * The views a generated candidate can show: one photograph per camera position, the front
 * first. The analyser's own view vocabulary (what a sketch draws: front, back, side) is a
 * different thing; a drawn side stands for both profiles.
 */
export const CANDIDATE_VIEWS = ['front', 'back', 'left', 'right'] as const;
export type CandidateView = (typeof CANDIDATE_VIEWS)[number];

export const confidenceSchema = z.number().min(0).max(1);

/**
 * Per-aspect outcome carried on an `Evaluation`; a part is `part: {name}`. `expected` and
 * `observed` are the critic's short descriptions of the reference and of the view.
 */
export const attributeResultSchema = z.object({
  attribute: z.string(),
  expected: z.string(),
  observed: z.string(),
  /** `close` is only on evaluations stored before the pairwise critic. */
  outcome: z.enum(['match', 'close', 'mismatch', 'skipped']),
  confidence: confidenceSchema,
  /** The critic's one-line reason for its answer. */
  reason: z.string().optional(),
});
export type AttributeResult = z.infer<typeof attributeResultSchema>;
