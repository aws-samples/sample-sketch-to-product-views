import {
  presignRequestSchema,
  sanitizePresignBody,
  type PresignResponse,
} from '@sketch-to-product-views/contracts';
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  getArtifact,
  headArtifact,
  inputKey,
  isOwnedKey,
  presignDownload,
  presignUpload,
  sniffImageType,
  type StoredObject,
} from '@sketch-to-product-views/shared/store';
import {
  badRequest,
  caller,
  fail,
  json,
  parseBody,
  type ApiEvent,
  type ApiResult,
} from '../http.js';

/**
 * Upload, in three legs: presign → the browser PUTs straight to S3 → confirm.
 *
 * The bytes never pass through this Lambda, which is why a large sketch costs nothing
 * here and why the 6 MB API Gateway payload ceiling is irrelevant.
 */

const PRODUCT_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

export async function presign(event: ApiEvent): Promise<ApiResult> {
  // First, so the key is minted under the verified caller's own prefix and nobody else's.
  const owner = caller(event).sub;
  const parsed = presignRequestSchema.safeParse(sanitizePresignBody(parseBody(event)));
  if (!parsed.success) return badRequest(parsed.error);
  const { productId, filename, contentType, sizeBytes } = parsed.data;

  if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
    return fail(415, `Unsupported type ${contentType}.`);
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) return fail(413, 'File exceeds 3.75 MB.');

  // `inputKey` interpolates the product id into the object key verbatim, so anything
  // path-like here would sign an upload outside the run's own prefix.
  if (!PRODUCT_ID.test(productId)) return fail(400, 'productId: not a valid product id.');

  // Uploads live outside the per-revision prefix. A presign happens before any revision
  // exists, so there is no revision id and no `createdAt` to build a revision segment from,
  // and inventing one would put a fake revision in the key. The uuid inside `inputKey` is
  // what makes the key unique; the revision then references it by the key echoed back here,
  // so nothing needs to be able to derive it from a revision.
  const key = inputKey(owner, productId, filename);

  const response: PresignResponse = {
    uploadUrl: await presignUpload(key, contentType),
    key,
    // A presigned GET rather than a CloudFront path: the artifacts bucket is private and
    // only the API is allowed to hand out reads.
    cdnUrl: await presignDownload(key),
    contentType,
  };

  return json(200, response);
}

/**
 * Third leg. Confirms the object landed and that its first bytes really are the image
 * type the client declared — the declared `contentType` is signed into the upload URL, so
 * without this check a client could still sign a PNG and store arbitrary bytes under it.
 */
/**
 * Keys this route will look at: exactly what `inputKey()` mints. Without the constraint,
 * confirm would HEAD any key in the bucket and report its size and content type back,
 * which makes it an oracle for objects the caller never uploaded.
 */
const INPUT_KEY = /^user\/[A-Za-z0-9_.:=+@-]{1,128}\/product\/[\w.-]{1,64}\/uploads\/[\w-]+\/[\w.-]+$/;

export async function confirm(event: ApiEvent): Promise<ApiResult> {
  const owner = caller(event).sub;
  const body = parseBody(event) as { key?: unknown };
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return fail(400, 'Missing key.');
  // Both: the shape of an upload key, and under this caller's own prefix.
  if (!INPUT_KEY.test(key) || !isOwnedKey(owner, key)) return fail(400, 'Not an upload key.');

  const checked = await checkUploadedImage(
    () => headArtifact(key),
    // A ranged read: 16 bytes is enough to identify the container, and pulling a whole
    // image into a 512 MB Lambda to look at its header would be absurd.
    () => getArtifact(key, 'bytes=0-15'),
  );
  if (!checked.ok) return fail(checked.status, checked.error);

  return json(200, { ok: true, key });
}

export type UploadCheck =
  | { ok: true; contentType: string; sizeBytes: number }
  | { ok: false; status: number; error: string };

/**
 * The byte check behind confirm: the object exists, is not
 * empty or oversized, and its first bytes are the image type S3 recorded for it.
 * `firstBytes` must return at least the first 16 bytes.
 */
export async function checkUploadedImage(
  head: () => Promise<StoredObject | undefined>,
  firstBytes: () => Promise<Uint8Array>,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<UploadCheck> {
  const stored = await head();
  if (!stored) return { ok: false, status: 400, error: 'Upload did not complete.' };
  if (stored.sizeBytes === 0) return { ok: false, status: 400, error: 'Uploaded file is empty.' };
  if (stored.sizeBytes > maxBytes)
    return { ok: false, status: 413, error: 'File exceeds 3.75 MB.' };

  const sniffed = sniffImageType(await firstBytes());
  if (!sniffed) return { ok: false, status: 415, error: 'File is not a JPEG, PNG or WebP image.' };
  if (sniffed !== stored.contentType) {
    return {
      ok: false,
      status: 415,
      error: `File is a ${sniffed}, not the declared ${stored.contentType}.`,
    };
  }
  return { ok: true, contentType: sniffed, sizeBytes: stored.sizeBytes };
}
