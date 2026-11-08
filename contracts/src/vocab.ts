/**
 * Deterministic clean-up of a spec value before it reaches a prompt: trim, collapse whitespace,
 * lower-case. Translation and abbreviations are left to the analyser, which reads the product
 * details in whatever language they are written.
 *
 * Idempotent: normalising the output again changes nothing, which is what lets the spec keep
 * `raw` and `value` side by side safely. To expand your own abbreviations deterministically,
 * map whole words here; never translate a token you are unsure of.
 */
export function normalise(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}
