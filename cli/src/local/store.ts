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
 * Keys keep their S3 shape. `inputs/` is a read-only prefix: the files the run was given.
 */

export {
  candidateKey,
  deliveryKey,
  inputKey,
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
/** Where `inputs/` keys resolve: the directory holding the sketch and material sample. */
export const INPUTS_DIR = resolve(process.env.LOCAL_INPUTS_DIR ?? REPO);

/** The file behind a key. A key never climbs out of its root. */
export function artifactPath(key: string): string {
  if (key.split('/').includes('..')) throw new Error(`invalid key: ${key}`);
  if (key.startsWith('inputs/')) return join(INPUTS_DIR, key.slice('inputs/'.length));
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

export async function getRevision(revisionId: string): Promise<PipelineState | undefined> {
  return get(revisionId);
}

export async function patchRevision(
  revisionId: string,
  delta: Partial<Omit<PipelineState, 'revisionId' | 'stages' | 'events'>>,
): Promise<void> {
  patch(revisionId, delta);
}

export async function emit(
  revisionId: string,
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
  const state = emitEvent(revisionId, stage, status, opts);
  return state.events[state.events.length - 1];
}

/** Held apart from the revision, as in DynamoDB: the browser never sees it. */
const callbacks = new Map<string, string>();

export async function setReviewCallbackId(revisionId: string, callbackId: string): Promise<void> {
  callbacks.set(revisionId, callbackId);
}

export async function getReviewCallbackId(revisionId: string): Promise<string | undefined> {
  return callbacks.get(revisionId);
}
