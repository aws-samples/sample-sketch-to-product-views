import type { CandidateView, DesignKind, ProductSpec } from '@sketch-to-product-views/contracts';
import { selectParam, type ModelEntry } from '../registry/index.js';
import { buildPrompt } from './prompt.js';

/**
 * How the four views of an attempt are made, one call and one image each.
 *
 * The front comes from the sketch and the material sample. The back comes from the front render,
 * and the left and the right from both the front and the back renders, so they share their
 * material and details and join the two edges of the object. The sketch and the sample go in
 * again only when the sketch draws that view: a second statement of the construction otherwise
 * only competes with the render.
 */

/** The views made from the front render; the pipeline runs them together. */
export const VIEWS_FROM_FRONT: readonly Exclude<CandidateView, 'front'>[] = [
  'back',
  'left',
  'right',
];

/** The profiles, made once the back exists: they are given both the front and the back. */
export const PROFILES: readonly Extract<CandidateView, 'left' | 'right'>[] = ['left', 'right'];

/** What a call can be given, in the order it is sent. `swatch` is the material sample. */
export type ViewInput = 'sketch' | 'swatch' | 'front_render' | 'back_render';

export interface ViewCall {
  view: CandidateView;
  /** The images to send, in this order. The first fills the dispatcher's `sketch` slot. */
  inputs: ViewInput[];
  prompt: string;
}

/** The analyser's view that covers a generated view: a drawn side stands for both profiles. */
export function drawnViewFor(view: CandidateView): 'front' | 'back' | 'side' {
  return view === 'left' || view === 'right' ? 'side' : view;
}

/**
 * True when the sketch draws the view. A spec without `views` predates the analyser reporting
 * them, and its sketch is taken to be the front.
 */
export function sketchDraws(spec: ProductSpec, view: CandidateView): boolean {
  return (spec.views ?? ['front']).includes(drawnViewFor(view));
}

export interface ViewCallOptions {
  /** The product has a material sample and the model takes it. */
  hasSwatch: boolean;
  notes?: string;
  /** What the critic found on this view's previous image, when it was rejected. */
  corrections?: string[];
  /** What the design team asked to change on this view, at review. */
  requests?: string[];
  /** How many uploaded images the `sketch` input stands for. One when omitted. */
  sketchImages?: number;
  /** How many of those, at their end, are further material samples (references only). */
  materialReferences?: number;
  /** What each design reference is, in upload order; all sketches when omitted. */
  designKinds?: readonly DesignKind[];
}

/** The images and the prompt of one view's call. */
export function planViewCall(
  view: CandidateView,
  spec: ProductSpec,
  {
    hasSwatch,
    notes,
    corrections,
    requests,
    sketchImages,
    materialReferences,
    designKinds,
  }: ViewCallOptions,
): ViewCall {
  const swatch: ViewInput[] = hasSwatch ? ['swatch'] : [];
  if (view === 'front') {
    return {
      view,
      inputs: ['sketch', ...swatch],
      prompt: buildPrompt(spec, {
        notes,
        swatch: hasSwatch,
        corrections,
        requests,
        sketchImages,
        materialReferences,
        designKinds,
      }),
    };
  }
  // A profile joins the front and the back, so it sees both renders.
  const profile = view === 'left' || view === 'right';
  const renders: ViewInput[] = profile ? ['front_render', 'back_render'] : ['front_render'];
  if (sketchDraws(spec, view)) {
    return {
      view,
      inputs: ['sketch', ...swatch, ...renders],
      prompt: buildPrompt(spec, {
        notes,
        swatch: hasSwatch,
        view,
        frontRender: 'with_sketch',
        backRender: profile,
        corrections,
        requests,
        sketchImages,
        materialReferences,
        designKinds,
      }),
    };
  }
  return {
    view,
    inputs: renders,
    prompt: buildPrompt(spec, {
      notes,
      swatch: hasSwatch,
      view,
      frontRender: 'alone',
      backRender: profile,
      corrections,
      requests,
      designKinds,
    }),
  };
}

/**
 * The call's inputs resolved to whatever the caller holds for them (bytes, or storage keys),
 * in call order. An input given as a list (the `sketch`, one entry per uploaded image) stands
 * for all of its entries, in order. An input the plan needs and the caller lacks is a bug, not
 * a quiet omission.
 */
export function viewInputs<T>(
  inputs: readonly ViewInput[],
  available: Partial<Record<ViewInput, T | readonly T[]>>,
): T[] {
  return inputs.flatMap((input) => {
    const value = available[input];
    const values = value === undefined ? [] : Array.isArray(value) ? value : [value as T];
    if (values.length === 0) {
      throw new Error(`the ${input.replace('_', ' ')} is needed for this view and was not given`);
    }
    return values;
  });
}

/** Overrides of the registry defaults: a run's settings, else the deployment's (Terraform). */
export interface ImageOverrides {
  size?: string;
  quality?: string;
  complexity?: string;
}

/** The image parameters a run can set; each is sent only when the entry declares it. */
export const IMAGE_SETTING_KEYS = ['size', 'quality', 'complexity'] as const;

/**
 * The settings every view is rendered at: the registry entry's defaults unless overridden, and
 * only with values the entry offers. One place, so the four views of an attempt never differ.
 */
export function imageSettings(
  entry: ModelEntry,
  overrides: ImageOverrides = {},
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of IMAGE_SETTING_KEYS) {
    if (!entry.params.some((p) => p.key === key)) continue;
    const value = selectParam(entry, key, overrides[key]);
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}
