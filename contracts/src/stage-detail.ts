import type { StageDetail } from './pipeline.js';

/**
 * Builds the `detail` recorded on a stage event, under a hard byte budget.
 *
 * Shared by the durable pipeline and the local runner so both produce the same shape, and so the
 * budget is enforced in one place rather than trusted to every call site.
 *
 * **Why a budget at all.** Details live on events, events live on the run document, and the SPA
 * polls that whole document every second while a run is live. An unbounded snapshot is therefore
 * not a local cost: one stage recording a base64 image would make every subsequent poll of that
 * run carry it, for the lifetime of the revision. DynamoDB's 400 KB item limit would eventually
 * stop it, but far too late to be a useful guard.
 *
 * Over budget, the snapshot is replaced rather than sliced. A JSON document cut in half is not a
 * smaller document, it is a broken one, and the UI would have to guess whether it was looking at
 * the truth. Saying "too large, here is its shape" is honest and still useful.
 */

/** Per snapshot, not per event. Generous for a spec or a verdict; far below a payload. */
export const DETAIL_BUDGET_BYTES = 4096;

export function captureDetail(parts: {
  input?: unknown;
  output?: unknown;
  facts?: Record<string, string | number | boolean | undefined>;
}): StageDetail {
  const input = fit(parts.input);
  const output = fit(parts.output);

  const detail: StageDetail = {};
  if (input.value !== undefined) detail.input = input.value;
  if (output.value !== undefined) detail.output = output.value;

  if (parts.facts) {
    // Dropping undefined keeps callers from having to build the object conditionally, and stops
    // an absent latency from rendering as an empty row in the UI.
    const facts = Object.fromEntries(
      Object.entries(parts.facts).filter(([, v]) => v !== undefined),
    ) as Record<string, string | number | boolean>;
    if (Object.keys(facts).length > 0) detail.facts = facts;
  }

  if (input.truncated || output.truncated) detail.truncated = true;
  return detail;
}

/**
 * JSON round-trips the value, both to drop `undefined` and class instances that would not
 * survive the wire anyway, and to measure what will actually be stored.
 */
function fit(value: unknown): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false };

  const json = JSON.stringify(value);
  if (json === undefined) return { value: undefined, truncated: false };

  // `length` is close enough: these are ASCII-dominated documents, and the budget is a guard
  // rail rather than an accounting boundary.
  if (json.length <= DETAIL_BUDGET_BYTES) return { value: JSON.parse(json), truncated: false };

  return { value: { omitted: describe(value), bytes: json.length }, truncated: true };
}

/** Enough to know what was dropped: the shape, not the contents. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (value !== null && typeof value === 'object') {
    return `object with keys ${Object.keys(value as object).join(', ')}`;
  }
  return typeof value;
}
