import type { CandidateView, Evaluation, ProductSpec } from '@sketch-to-product-views/contracts';

/**
 * The port stage 06 evaluates a generated 2D image through. `createJudgeCritic`
 * (`qc/judge`) implements it: one call compares the view with its references, code decides.
 */

export interface CriticInput {
  /** The design reference: the first sketch the analyser found, else the first photo. */
  sketch: Uint8Array;
  /** `photo` when no image is a sketch and a photo stands in. A sketch when omitted. */
  sketchKind?: 'sketch' | 'photo';
  /** Sketches arrive as whatever the designer uploaded — jpeg as often as png. */
  sketchContentType: string;
  candidate: Uint8Array;
  candidateContentType: string;
  spec: ProductSpec;
  /** The material sample, as the analyser identified it, when there is one. */
  swatch?: Uint8Array;
  swatchContentType?: string;
  /** Model override for the critic; omitted means the registry default. */
  modelId?: string;
  /** Which view the candidate renders. Omitted, it is read as a front view. */
  view?: CandidateView;
  /**
   * What the design team asked to change on this view at review. Each one is checked on the
   * candidate; one not applied fails it.
   */
  requests?: readonly string[];
  /**
   * The aspects those requests change, on any view. They are no longer compared with
   * the sketch, the material sample or the spec, which the reviewer asked to depart from.
   */
  changed?: readonly string[];
}

export interface Critic {
  evaluate(input: CriticInput): Promise<Evaluation>;
}

/** Bedrock accepts a narrow set of image formats in Converse content blocks. */
const FORMATS: Record<string, 'png' | 'jpeg' | 'webp' | 'gif'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function imageFormat(contentType: string): 'png' | 'jpeg' | 'webp' | 'gif' {
  const format = FORMATS[contentType];
  if (!format) throw new Error(`critic cannot read ${contentType}`);
  return format;
}
