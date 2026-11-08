import { validatePackage } from '@sketch-to-product-views/contracts';
import { screenText, type ScreenField } from '@sketch-to-product-views/shared/guardrail';
import { checkInputImage, checkInputSize } from '@sketch-to-product-views/shared/image';
import { getArtifact, headArtifact, sniffImageType } from '@sketch-to-product-views/shared/store';
import type { PipelineInput } from '../input.js';

/**
 * Validates the package.
 *
 * The API already ran `validatePackage` on submit, and this runs it again. That is not
 * redundancy for its own sake: this is the first layer that reads the *stored bytes*, so
 * it catches the case the API cannot — a manifest that references an object which was
 * never fully uploaded, or whose content does not match what the client declared.
 *
 * Each input must also satisfy every model it will be sent to (`checkInputImage`): an
 * oversized sketch rejected here costs nothing, while the same sketch reaching the critic
 * fails the run after a paid generation. The size is checked on `HeadObject` first, so an
 * object over the limit is never downloaded; only then is the whole object read, which the
 * size cap bounds to a few megabytes, and decoded for its format and dimensions.
 *
 * Every file is checked before anything is thrown, so one failed run names all the bad
 * files instead of revealing them one resubmission at a time.
 *
 * Then, with a guardrail configured, every string the user wrote at submit (product id, file
 * names, product details, design notes) is screened before any model reads it: a block is a
 * terminal `GuardrailBlockedError` naming the field and the policy.
 */
export class ValidationError extends Error {}

/** What the stage found for one input, recorded on the event so the checks are auditable. */
export interface FileCheck {
  filename: string;
  /** The type proved by the magic bytes, which is not necessarily what the client declared. */
  detectedType: string;
  readable: true;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface ValidateResult {
  message: string;
  checks: FileCheck[];
  warnings: string[];
  /** Whether the submit-time text was screened by the guardrail, and how many fields. */
  screened: { guardrail: boolean; fields: number };
}

type FileResult = { check: FileCheck } | { error: string };

async function checkFile(file: PipelineInput['inputs'][number]): Promise<FileResult> {
  if (!file.key) return { error: `${file.filename} has no storage key and cannot be read.` };

  let bytes: Uint8Array;
  try {
    const head = await headArtifact(file.key);
    if (!head) return { error: `${file.filename} could not be read from storage.` };

    const tooLarge = checkInputSize(head.sizeBytes);
    if (tooLarge) return { error: `${file.filename}: ${tooLarge}.` };

    bytes = await getArtifact(file.key);
  } catch {
    return { error: `${file.filename} could not be read from storage.` };
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed) return { error: `${file.filename} is not a readable JPEG, PNG or WebP.` };

  let checked: Awaited<ReturnType<typeof checkInputImage>>;
  try {
    checked = await checkInputImage(bytes);
  } catch {
    return { error: `${file.filename} could not be decoded as an image.` };
  }
  if (!checked.ok) return { error: `${file.filename}: ${checked.issues.join('; ')}.` };

  return {
    check: {
      filename: file.filename,
      detectedType: sniffed,
      readable: true,
      sizeBytes: checked.sizeBytes,
      width: checked.width,
      height: checked.height,
    },
  };
}

export async function validate(input: PipelineInput): Promise<ValidateResult> {
  const { errors, warnings } = validatePackage(input.inputs);
  if (errors.length > 0) throw new ValidationError(errors.join(' '));

  const checks: FileCheck[] = [];
  const failures: string[] = [];

  // Sequential rather than parallel: at most five files, and it keeps at most one image
  // in memory at a time.
  for (const file of input.inputs) {
    const result = await checkFile(file);
    if ('error' in result) failures.push(result.error);
    else checks.push(result.check);
  }

  if (failures.length > 0) throw new ValidationError(failures.join(' '));

  const screened = await screenText(submittedText(input));

  return {
    message: `${input.inputs.length} file(s) present, readable and within the model limits.`,
    checks,
    warnings,
    screened: { guardrail: screened.screened, fields: screened.fields },
  };
}

/** Every string the user wrote at submit, by field. */
export function submittedText(input: PipelineInput): ScreenField[] {
  return [
    { label: 'Product ID', text: input.productId },
    { label: 'File names', text: input.inputs.map((f) => f.filename).join('\n') },
    { label: 'Product details', text: input.productMetadata?.text ?? '' },
    { label: 'Design notes', text: input.requests?.notes ?? '' },
  ];
}
