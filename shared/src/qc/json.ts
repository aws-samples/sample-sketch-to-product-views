/**
 * Model output is untrusted text. These two turn it into a value without throwing, so a model
 * that answers in prose instead of JSON is a shape failure the caller can attribute, not a bare
 * `SyntaxError`. Shared by the critic and the analyser.
 */

/** Models occasionally wrap JSON in a fence despite instructions. Cheap to tolerate. */
export function stripFence(text: string): string {
  // indexOf, not a regex: the text is model output, and a lazy match over it can backtrack badly.
  const open = text.indexOf('```');
  if (open === -1) return text.trim();
  const close = text.indexOf('```', open + 3);
  if (close === -1) return text.trim();
  let body = text.slice(open + 3, close);
  if (body.startsWith('json')) body = body.slice(4);
  return body.trim();
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
