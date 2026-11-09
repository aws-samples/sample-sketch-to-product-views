import type { DurableContext } from '@aws/durable-execution-sdk-js';
import type { PipelineState, StageEvent } from '@sketch-to-product-views/contracts';
// Bound here, before any test mocks the module: the real ownership check, not a copy of it.
import { isOwnedKey } from '@sketch-to-product-views/shared/store';

/**
 * In-memory stand-ins for the pipeline's two boundaries: the durable context and the store.
 *
 * The context runs each step once and, on failure, asks the step's own `retryStrategy`
 * whether to run it again — the same decision the SDK makes, minus the delay — so a test sees
 * exactly which failures the pipeline retries. `parallel` runs its branches together on the
 * same context and settles them all, as the SDK's batch does. The store is the subset of
 * `@sketch-to-product-views/shared/store` the rail touches, backed by maps.
 */

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  record: Record<string, unknown>;
}

export interface FakeContext {
  ctx: DurableContext;
  /** Step names in the order they ran, one entry per attempt. */
  steps: string[];
  /** What the context's and the steps' loggers were given, in order. */
  logs: LogLine[];
}

type RetryStrategy = (error: Error, attemptCount: number) => { shouldRetry: boolean };

/**
 * `decisions` are the review decisions the gate receives, in order, each as the API sends it.
 * A wait with none left throws, so a test cannot park forever.
 */
export function fakeContext(decisions: unknown[] = []): FakeContext {
  const steps: string[] = [];
  const logs: LogLine[] = [];
  const at = (level: LogLine['level']) => (record: Record<string, unknown>) => {
    logs.push({ level, record });
  };
  const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  const ctx = {
    logger,
    async step<T>(
      name: string,
      fn: (step: { attempt: number; logger: typeof logger }) => Promise<T>,
      opts?: { retryStrategy?: RetryStrategy },
    ): Promise<T> {
      for (let attempt = 1; ; attempt += 1) {
        steps.push(name);
        try {
          return await fn({ attempt, logger });
        } catch (error) {
          const decision = opts?.retryStrategy?.(error as Error, attempt);
          if (!decision?.shouldRetry) throw error;
        }
      }
    },
    async wait(name: string) {
      steps.push(name);
    },
    async waitForCallback<T>(name: string, submitter: (callbackId: string) => Promise<void>) {
      steps.push(name);
      await submitter(`callback-${name}`);
      const decision = decisions.shift();
      if (decision === undefined) throw new Error(`no review decision queued for ${name}`);
      return JSON.stringify(decision) as T;
    },
    async parallel<T>(
      _name: string,
      branches: { name?: string; func: (branch: DurableContext) => Promise<T> }[],
    ) {
      const settled = await Promise.allSettled(branches.map((b) => b.func(ctx)));
      const all = settled.map((s, index) =>
        s.status === 'fulfilled'
          ? { index, status: 'SUCCEEDED', result: s.value }
          : { index, status: 'FAILED', error: s.reason as Error },
      );
      const succeeded = all.filter((i) => i.status === 'SUCCEEDED');
      const failed = all.filter((i) => i.status === 'FAILED');
      return {
        all,
        succeeded: () => succeeded,
        failed: () => failed,
        getResults: () => succeeded.map((i) => i.result as T),
        getErrors: () => failed.map((i) => i.error),
        throwIfError: () => {
          if (failed[0]) throw failed[0].error;
        },
        hasFailure: failed.length > 0,
        successCount: succeeded.length,
        failureCount: failed.length,
        totalCount: all.length,
      };
    },
  } as unknown as DurableContext;
  return { ctx, steps, logs };
}

export interface FakeStore {
  objects: Map<string, Uint8Array>;
  revision: Partial<PipelineState>;
  events: Pick<StageEvent, 'stage' | 'status' | 'message' | 'attempt'>[];
  /** Every revision address the pipeline used, so a test can check whose keys it wrote. */
  refs: { owner: string; revisionId: string }[];
  exports: Record<string, unknown>;
}

/** `sniffImageType` is passed in: the real one, bound before the module is mocked. */
export function fakeStore(sniffImageType: (bytes: Uint8Array) => string | undefined): FakeStore {
  const store: FakeStore = {
    objects: new Map(),
    revision: {},
    events: [],
    refs: [],
    exports: {},
  };
  const track = (ref: { owner: string; revisionId: string }) => store.refs.push(ref);
  store.exports = {
    sniffImageType,
    isOwnedKey,
    headArtifact: async (key: string) => {
      const bytes = store.objects.get(key);
      return bytes && { contentType: 'application/octet-stream', sizeBytes: bytes.byteLength };
    },
    getArtifact: async (key: string) => {
      const bytes = store.objects.get(key);
      if (!bytes) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
      return bytes;
    },
    putArtifact: async (key: string, bytes: Uint8Array) => {
      store.objects.set(key, bytes);
    },
    patchRevision: async (ref: { owner: string; revisionId: string }, delta: Partial<PipelineState>) => {
      track(ref);
      Object.assign(store.revision, delta);
    },
    getRevision: async (ref: { owner: string; revisionId: string }) => {
      track(ref);
      return store.revision;
    },
    emit: async (
      ref: { owner: string; revisionId: string },
      stage: StageEvent['stage'],
      status: StageEvent['status'],
      opts: { message?: string; attempt?: number } = {},
    ) => {
      track(ref);
      store.events.push({
        stage,
        status,
        message: opts.message,
        ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {}),
      });
      return {};
    },
    // Not reached by the intake stages; present so the handler module binds.
    deliveryKey: () => 'delivery',
    revisionSegment: (createdAt: string, revisionId: string) => `${createdAt}-${revisionId}`,
    candidateKey: () => 'candidate',
    setReviewCallbackId: async (ref: { owner: string; revisionId: string }) => {
      track(ref);
    },
    importArtifact: async (from: { bucket: string; key: string }, key: string) => {
      store.objects.set(key, new TextEncoder().encode(`${from.bucket}/${from.key}`));
    },
  };
  return store;
}
