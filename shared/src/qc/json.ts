/**
 * Model output is untrusted text. These two turn it into a value without throwing, so a model
 * that answers in prose instead of JSON is a shape failure the caller can attribute, not a bare
 * `SyntaxError`. Shared by the critic and the analyser.
 */

/** Models occasionally wrap JSON in a fence despite instructions. Cheap to tolerate. */
export function stripFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
