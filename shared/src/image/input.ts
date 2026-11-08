import sharp, { type Metadata } from 'sharp';
import { INPUT_IMAGE_MAX_BYTES } from './limits.js';

/**
 * The upload validation gate on every image and swatch: the intersection of the limits of every
 * model an input is sent to. Converse (the critic, and the analyser to come) is the tightest —
 * at most 3.75 MB and 8000 px per side; GPT image edits accept png, webp and jpg up to 50 MB.
 * Checked before any paid call, so an oversized sketch fails at validation rather than at the
 * critic, after a generation has already been paid for.
 *
 * No other minimum side or aspect ratio is enforced: the registry's models accept them.
 *
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html
 */

export { INPUT_IMAGE_MAX_BYTES };
export const INPUT_IMAGE_MAX_SIDE = 8000;
/** gif is left out: the presign allowlist refuses it and GPT image edits do not take it. */
export const INPUT_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;

/**
 * The size rule alone, pure, so upload validation can apply it to a `HeadObject` result and never
 * download an object it is going to reject anyway.
 */
export function checkInputSize(sizeBytes: number): string | undefined {
  if (sizeBytes <= INPUT_IMAGE_MAX_BYTES) return undefined;
  return `too large: ${megabytes(sizeBytes)}, the limit is ${megabytes(INPUT_IMAGE_MAX_BYTES)}`;
}

export interface InputImageCheck {
  ok: boolean;
  issues: string[];
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
}

export async function checkInputImage(bytes: Uint8Array): Promise<InputImageCheck> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch (cause) {
    throw new Error('image could not be decoded', { cause });
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const format = meta.format ?? 'unknown';
  const sizeBytes = bytes.byteLength;
  const issues: string[] = [];

  if (!INPUT_IMAGE_FORMATS.has(format)) {
    issues.push(`unsupported format: ${format} (need jpeg, png or webp)`);
  }
  if (width > INPUT_IMAGE_MAX_SIDE) {
    issues.push(`${width} px wide, the limit is ${INPUT_IMAGE_MAX_SIDE} px per side`);
  }
  if (height > INPUT_IMAGE_MAX_SIDE) {
    issues.push(`${height} px tall, the limit is ${INPUT_IMAGE_MAX_SIDE} px per side`);
  }
  // Checked again on the bytes actually read: the HEAD size is the store's claim, these are not.
  const size = checkInputSize(sizeBytes);
  if (size) issues.push(size);

  return { ok: issues.length === 0, issues, width, height, format, sizeBytes };
}
