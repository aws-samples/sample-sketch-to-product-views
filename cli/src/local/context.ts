import type { DurableContext, Duration, RetryDecision } from '@aws/durable-execution-sdk-js';

/**
 * The durable context the pipeline handler gets in `npm run 2d`, in-process.
 *
 * It runs each step once, retrying it as its `retryStrategy` says, after the delay it asks for;
 * runs `parallel` branches together and settles them all, as the SDK's batch does; and parks
 * `waitForCallback` on a promise that `complete` resolves. Nothing is checkpointed: a server
 * restart loses the runs in flight, which a local run can afford.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Logger = Record<Level, (record: Record<string, unknown>) => void>;

function consoleLogger(revisionId: string): Logger {
  const line = (level: Level) => (record: Record<string, unknown>) => {
    if (level === 'debug') return;
    const { event, step, reason } = record;
    const text = [`[local] ${revisionId.slice(0, 8)}`, event, step, reason].filter(Boolean);
    (level === 'info' ? console.log : console.warn)(text.join(' '));
  };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
}

const milliseconds = (d: Duration | undefined) => {
  if (d === undefined) return 1000;
  const {
    days = 0,
    hours = 0,
    minutes = 0,
    seconds = 0,
  } = d as Partial<Record<'days' | 'hours' | 'minutes' | 'seconds', number>>;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LocalContext {
  ctx: DurableContext;
  /** Resolves the wait a callback id stands for. False when nothing waits on it. */
  complete(callbackId: string, result: string): boolean;
}

export function localContext(revisionId: string): LocalContext {
  const logger = consoleLogger(revisionId);
  const waiting = new Map<string, (result: string) => void>();
  const ctx = {
    logger,
    async step<T>(
      _name: string,
      fn: (step: { attempt: number; logger: Logger }) => Promise<T>,
      opts?: { retryStrategy?: (error: Error, attempt: number) => RetryDecision },
    ): Promise<T> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await fn({ attempt, logger });
        } catch (error) {
          const decision = opts?.retryStrategy?.(error as Error, attempt);
          if (!decision?.shouldRetry) throw error;
          await sleep(milliseconds(decision.delay));
        }
      }
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
    async wait(_name: string, duration: Duration) {
      await sleep(milliseconds(duration));
    },
    async waitForCallback(name: string, submitter: (callbackId: string) => Promise<void>) {
      const callbackId = `${revisionId}:${name}`;
      const result = new Promise<string>((resolve) => waiting.set(callbackId, resolve));
      await submitter(callbackId);
      return result;
    },
  } as unknown as DurableContext;

  return {
    ctx,
    complete(callbackId, result) {
      const resolve = waiting.get(callbackId);
      if (!resolve) return false;
      waiting.delete(callbackId);
      resolve(result);
      return true;
    },
  };
}
