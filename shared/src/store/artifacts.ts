import { INPUT_IMAGE_MAX_BYTES } from '../image/limits.js';
import { randomUUID } from 'node:crypto';
import { assertOwnerId } from './owner.js';
import { LONGEST_URL_SECONDS, scopedClients } from './scope.js';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3 artifact store.
 *
 * Every byte the browser reads or writes goes through a presigned URL minted here.
 * The bucket stays private and the SPA never sees a key it was not handed — which is
 * what lets `contracts` stay free of any storage concept: the wire type carries a
 * `cdnUrl`, not a key.
 *
 * Layout:
 *   user/{owner}/product/{productId}/uploads/{uuid}/{filename}            uploaded sketches and swatches
 *   user/{owner}/product/{productId}/{revSegment}/candidates/{id}.{ext}   generated 2D images
 *   user/{owner}/product/{productId}/{revSegment}/delivery/{filename}     delivered approved assets
 *
 * `{owner}` is the submitter's Cognito `sub`. Every key a user can reach sits under their own
 * `user/{owner}/` prefix, which is what the API's per-user role is limited to in IAM
 * (`arn:…:{bucket}/user/${aws:PrincipalTag/sub}/*`, infra/modules/api).
 *
 * `revSegment` is `{compacted createdAt}-{revisionId}` — see `revisionSegment`. It replaced a
 * hardcoded `rev1`, which made every revision of a product share one prefix and let a second
 * approved run silently overwrite the first run's delivered asset.
 *
 * Uploads sit outside the revision prefix because a presign is issued *before* the revision
 * exists: there is no revision id and no `createdAt` to derive a segment from. Their `{uuid}`
 * already makes them unique, and nothing reads them by anything other than the stored key.
 */

/** 15 minutes: long enough for a slow upload, short enough that a leaked URL is stale. */
const PUT_TTL_SECONDS = 900;
/**
 * 45 minutes: inside the one-hour session the API signs with, with room for the credential
 * reuse window (./scope.ts). An open tab still gets fresh URLs every 10 minutes (`etagFor`).
 */
const GET_TTL_SECONDS = LONGEST_URL_SECONDS;

export const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** The validate stage's limit, so an oversized file is refused before it is uploaded. */
export const MAX_UPLOAD_BYTES = INPUT_IMAGE_MAX_BYTES;

const BUCKET = () => {
  const bucket = process.env.ARTIFACTS_BUCKET;
  if (!bucket) throw new Error('ARTIFACTS_BUCKET is not set');
  return bucket;
};

/** The artifacts bucket, for a caller that copies between it and another bucket. */
export const artifactsBucket = (): string => BUCKET();

let s3: S3Client | undefined;

/** The current user scope's client (the API), else the function's own (the pipeline). */
function client(): S3Client {
  const scoped = scopedClients();
  if (scoped) return scoped.s3;
  s3 ??= new S3Client({});
  return s3;
}

/**
 * Strips anything that could escape the intended prefix or produce a key the operator
 * cannot read back. Done here rather than in the handler so no call site can forget it.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 128) || 'file';
}

/** Used when a revision's `createdAt` cannot be parsed. Sorts after every real stamp. */
const UNDATED_STAMP = 'undated';

/**
 * `2026-09-22T10:11:12.345Z` → `20260922T101112Z`.
 *
 * Colons are legal in an S3 key but awkward in a URL, in a shell and in the console's object
 * browser, so the stamp is compacted. Millisecond precision is dropped: the segment is made
 * unique by the revision id that follows it, so the stamp only has to order runs.
 *
 * Lexicographic order equals chronological order — that sortability is the whole reason the
 * segment carries a timestamp rather than being a bare uuid, since it is what makes a product's
 * prefixes list oldest-first in the console and in `s3 ls`.
 */
export function revisionStamp(createdAt: string): string {
  const parsed = new Date(createdAt);
  // Derived, never `Date.now()`: `pipeline` is a durable function, and a fresh
  // timestamp read outside a step is nondeterminism that breaks replay. The stored `createdAt`
  // is written once at creation and is therefore replay-safe.
  if (Number.isNaN(parsed.getTime())) return UNDATED_STAMP;
  return parsed
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * The per-revision key segment: sortable stamp first, then the revision id for uniqueness.
 * One helper so the candidate and delivery keys can never disagree about it.
 */
export function revisionSegment(createdAt: string, revisionId: string): string {
  return `${revisionStamp(createdAt)}-${revisionId}`;
}

/**
 * An upload key. Minted before any revision exists, so it is deliberately *not* under a
 * revision segment; the `{uuid}` is what keeps two uploads of the same filename apart.
 */
export function inputKey(owner: string, productId: string, filename: string): string {
  return `${ownerKeyPrefix(owner)}product/${productId}/uploads/${randomUUID()}/${safeFilename(filename)}`;
}

/** `user/{owner}/`: the only prefix a user's keys live under. */
export function ownerKeyPrefix(owner: string): string {
  return `user/${assertOwnerId(owner)}/`;
}

/** True when `key` sits under the owner's own prefix. */
export function isOwnedKey(owner: string, key: string): boolean {
  return key.startsWith(ownerKeyPrefix(owner)) && !key.split('/').includes('..');
}

export function candidateKey(
  owner: string,
  productId: string,
  revSegment: string,
  candidateId: string,
  contentType: string,
): string {
  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'png';
  return `${ownerKeyPrefix(owner)}product/${productId}/${revSegment}/candidates/${candidateId}.${ext}`;
}

/**
 * The delivery key. `filename` is derived deterministically from the product id, so this is
 * the key that *must* carry the revision segment: without it, approving a second run for the
 * same product overwrites the first run's delivered bytes while the older revision's stored
 * `deliveryKey` keeps pointing at them.
 */
export function deliveryKey(
  owner: string,
  productId: string,
  revSegment: string,
  filename: string,
): string {
  return `${ownerKeyPrefix(owner)}product/${productId}/${revSegment}/delivery/${safeFilename(filename)}`;
}

/**
 * The upload leg. `ContentType` is signed in, so the browser must send exactly the type
 * it declared — a client cannot presign a PNG and then upload something else.
 */
export async function presignUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }),
    { expiresIn: PUT_TTL_SECONDS },
  );
}

/** Capped at `GET_TTL_SECONDS`, so no URL outlives the session that signs it. */
export async function presignDownload(key: string, expiresIn = GET_TTL_SECONDS): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), {
    expiresIn: Math.min(expiresIn, GET_TTL_SECONDS),
  });
}

export interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

/**
 * Confirms an upload actually landed. Returns undefined for a missing object rather than
 * throwing, because "the client never completed the PUT" is an expected 400, not a fault.
 */
export async function headArtifact(key: string): Promise<StoredObject | undefined> {
  try {
    const head = await client().send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key }));
    return {
      contentType: head.ContentType ?? 'application/octet-stream',
      sizeBytes: head.ContentLength ?? 0,
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return undefined;
    throw error;
  }
}

/** `range` is an HTTP Range header value, e.g. `bytes=0-15` to read just a file header. */
export async function getArtifact(key: string, range?: string): Promise<Uint8Array> {
  const result = await client().send(
    new GetObjectCommand({ Bucket: BUCKET(), Key: key, Range: range }),
  );
  if (!result.Body) throw new Error(`empty object: ${key}`);
  return new Uint8Array(await result.Body.transformToByteArray());
}

/**
 * Reads an object from a bucket other than the artifacts one. Returns undefined for a missing
 * key, so a caller can answer 404 without parsing SDK error names.
 */
export async function getObjectIn(
  bucket: string,
  key: string,
  range?: string,
): Promise<Uint8Array | undefined> {
  try {
    const result = await client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
    );
    if (!result.Body) throw new Error(`empty object: ${key}`);
    return new Uint8Array(await result.Body.transformToByteArray());
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return undefined;
    throw error;
  }
}

/** `headArtifact` for a bucket other than the artifacts one. */
export async function headObjectIn(bucket: string, key: string): Promise<StoredObject | undefined> {
  try {
    const head = await client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentType: head.ContentType ?? 'application/octet-stream',
      sizeBytes: head.ContentLength ?? 0,
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return undefined;
    throw error;
  }
}

/**
 * A server-side copy, so no bytes pass through the caller. The caller's role needs `GetObject`
 * on the source and `PutObject` on the target; the content type is copied with the object.
 */
export async function copyObject(
  from: { bucket: string; key: string },
  to: { bucket: string; key: string },
): Promise<void> {
  // `CopySource` is a URL path: each key segment is encoded, the slashes kept.
  const source = [from.bucket, ...from.key.split('/')].map(encodeURIComponent).join('/');
  await client().send(
    new CopyObjectCommand({ CopySource: source, Bucket: to.bucket, Key: to.key }),
  );
}

/**
 * Copies an object another service wrote (a model's async output) into the artifacts bucket,
 * server side. The caller's role needs `GetObject` on the source, and `kms:Decrypt` when that
 * bucket encrypts with its own key.
 */
export async function importArtifact(
  from: { bucket: string; key: string },
  key: string,
): Promise<void> {
  await copyObject(from, { bucket: BUCKET(), key });
}

export async function deleteObjectIn(bucket: string, key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

let presigner: S3Client | undefined;

/**
 * With the default `WHEN_SUPPORTED`, the SDK writes the CRC32 of the empty body it signs into
 * the presigned URL, and S3 then rejects every real upload with a checksum mismatch.
 */
function presignClient(): S3Client {
  const scoped = scopedClients();
  if (scoped) return scoped.presigner;
  presigner ??= new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  return presigner;
}

/**
 * A presigned PUT into any bucket that binds both the content type and the exact length:
 * the browser must send that header and a body of exactly `contentLength` bytes, or S3
 * refuses the signature. Without `signableHeaders` the presigner leaves `content-type` out
 * of the signature and the type is not enforced.
 */
export async function presignUploadIn(
  bucket: string,
  key: string,
  opts: { contentType: string; contentLength: number; expiresIn: number },
): Promise<string> {
  return getSignedUrl(
    presignClient(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    }),
    { expiresIn: opts.expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
  );
}

export async function putArtifact(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: body, ContentType: contentType }),
  );
}

/**
 * Magic-byte check. A declared content type is a client assertion; these bytes are not.
 * Upload validation decodes the image properly with sharp — this is the cheap gate in front of it.
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  const ascii = (offset: number, text: string) =>
    bytes.length >= offset + text.length &&
    text.split('').every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return undefined;
}
