import { z } from 'zod';

/**
 * What a submission package may contain, and the one implementation of the rules.
 *
 * `validatePackage` is called by the SPA before it uploads, by the API on submit, and by
 * the pipeline's package validation, so the rule cannot drift between them.
 *
 * The designer uploads images and tags nothing. The analyser decides what each one is (a
 * sketch, a photo, a material sample, or unrelated) and which views it draws: sketches are not
 * uniform, and a per-file tag could not describe a sheet with several views on it.
 */

/**
 * Optional on the wire. `swatch` is what an older client or a stored run sent for a material
 * sample: it is accepted, and passed to the analyser as a hint, never as a decision.
 */
export const inputRoleSchema = z.enum(['image', 'swatch']);
export type InputRole = z.infer<typeof inputRoleSchema>;

/**
 * A product choice, not a model limit: the largest call this allows (five uploads and two
 * renders) stays under the 16 images a GPT Image edit and the 20 a Converse message accept.
 */
export const MAX_IMAGES = 5;

export interface PackageIssues {
  /** Blocks the submission. */
  errors: string[];
  /**
   * Allows it. Nothing produces one today: what each image is is for the analyser to say, and a
   * missing material sample or product details are information for the reviewer, not a warning.
   */
  warnings: string[];
}

/**
 * Package-level rules, which no per-file schema can express: how many images.
 *
 * Returns issues rather than throwing so the UI can show them all at once instead of
 * revealing them one failed submit at a time.
 */
export function validatePackage(inputs: readonly unknown[]): PackageIssues {
  const errors: string[] = [];
  if (inputs.length === 0) errors.push('At least one image is required.');
  if (inputs.length > MAX_IMAGES) errors.push(`At most ${MAX_IMAGES} images are allowed.`);
  return { errors, warnings: [] };
}
