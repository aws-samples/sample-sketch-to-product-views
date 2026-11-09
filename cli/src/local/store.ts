import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PipelineState,
  StageDetail,
  StageEvent,
  StageId,
  StageStatus,
} from '@sketch-to-product-views/contracts';
import { sniffImageType } from '@sketch-to-product-views/shared/store';
import { emit as emitEvent, get, patch } from './revisions.js';

/**
 * `@sketch-to-product-views/shared/store` for the pipeline run in-process by the CLI: revisions in memory,
 * artifacts as files. `../run.ts` points the pipeline's imports of the store here; nothing
 * reaches DynamoDB or S3.
 *
 * Keys keep their S3 shape, under the local owner's `user/cli/` prefix like any user's.
 * `user/cli/inputs/` is a read-only prefix: the files the run was given.
 */

/** The owner every local run belongs to; the keys it reads and writes sit under its prefix. */
export const LOCAL_OWNER = 'cli';
const INPUTS_PREFIX = `user/${LOCAL_OWNER}/inputs/`;

export {
  candidateKey,
  deliveryKey,
  inputKey,
  isOwnedKey,
  revisionSegment,
  safeFilename,
  sniffImageType,
} from '@sketch-to-product-views/shared/store';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
/** The run folder the CLI sets; `runs/` by default, ignored by git. */
export const LOCAL_ARTIFACTS_DIR = resolve(
  process.env.LOCAL_ARTIFACTS_DIR ?? join(REPO, 'runs'),
);
/** Where `user/cli/inputs/` keys resolve: the directory holding the sketch and material sample. */
export const INPUTS_DIR = resolve(process.env.LOCAL_INPUTS_DIR ?? REPO);

/** The file behind a key. A key never climbs out of its root. */
export function artifactPath(key: string): string {
  if (key.split('/').includes('..')) throw new Error(`invalid key: ${key}`);
  if (key.startsWith(INPUTS_PREFIX)) return join(INPUTS_DIR, key.slice(INPUTS_PREFIX.length));
  return join(LOCAL_ARTIFACTS_DIR, key);
}

export async function putArtifact(key: string, body: Uint8Array): Promise<void> {
  const path = artifactPath(key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export async function getArtifact(key: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(readFileSync(artifactPath(key)));
  } catch {
    throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
  }
}

export async function headArtifact(
  key: string,
): Promise<{ contentType: string; sizeBytes: number } | undefined> {
  try {
    const path = artifactPath(key);
    const header = readFileSync(path).subarray(0, 16);
    return {
      contentType: sniffImageType(header) ?? 'application/octet-stream',
      sizeBytes: statSync(path).size,
    };
  } catch {
    return undefined;
  }
}

/** The shared store's address type, structurally: one local owner, so only the id is used. */
type RevisionRef = { owner: string; revisionId: string };

export async function getRevision(ref: RevisionRef): Promise<PipelineState | undefined> {
  return get(ref.revisionId);
}

export async function patchRevision(
  ref: RevisionRef,
  delta: Partial<Omit<PipelineState, 'revisionId' | 'stages' | 'events'>>,
): Promise<void> {
  patch(ref.revisionId, delta);
}

export async function emit(
  ref: RevisionRef,
  stage: StageId,
  status: StageStatus,
  opts: {
    message?: string;
    attempt?: number;
    view?: StageEvent['view'];
    stubbed?: boolean;
    detail?: StageDetail;
  } = {},
): Promise<StageEvent> {
  const state = emitEvent(ref.revisionId, stage, status, opts);
  return state.events[state.events.length - 1];
}

/** Held apart from the revision, as in DynamoDB: the browser never sees it. */
const callbacks = new Map<string, string>();

export async function setReviewCallbackId(ref: RevisionRef, callbackId: string): Promise<void> {
  callbacks.set(ref.revisionId, callbackId);
}

export async function getReviewCallbackId(ref: RevisionRef): Promise<string | undefined> {
  return callbacks.get(ref.revisionId);
}
