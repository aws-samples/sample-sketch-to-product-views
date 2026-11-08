import type { StageDetail } from '@sketch-to-product-views/contracts';

/**
 * A stage's recorded input and output, side by side. Top-level keys the stage changed are
 * marked on the output, which answers "supplied or invented?" at a glance.
 */
export function StageIo({ detail }: { detail: StageDetail }) {
  const changed = changedKeys(detail.input, detail.output);

  return (
    <div className="io">
      {detail.facts ? (
        <dl className="io-facts">
          {Object.entries(detail.facts).map(([key, value]) => (
            <div key={key}>
              <dt>{label(key)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {detail.input !== undefined || detail.output !== undefined ? (
        <div className="io-panes">
          <Pane title="Before" value={detail.input} />
          <Pane title="After" value={detail.output} changed={changed} />
        </div>
      ) : null}

      {detail.truncated ? (
        <p className="muted io-note">
          A snapshot was too large to record in full, so its shape is stored instead of its
          contents.
        </p>
      ) : null}
    </div>
  );
}

function Pane({ title, value, changed }: { title: string; value: unknown; changed?: Set<string> }) {
  return (
    <figure className="io-pane">
      <figcaption>{title}</figcaption>
      {value === undefined ? (
        <p className="muted io-note">Nothing recorded.</p>
      ) : (
        <pre className="io-json">
          {lines(value).map((line, i) => (
            <span
              key={i}
              className={changed?.has(line.key ?? '') ? 'io-line io-line--changed' : 'io-line'}
            >
              {line.text}
            </span>
          ))}
        </pre>
      )}
    </figure>
  );
}

/** Pretty-printed JSON, each line tagged with its top-level key, for highlighting. */
function lines(value: unknown): { text: string; key?: string }[] {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  let current: string | undefined;

  return text.split('\n').map((line) => {
    const top = /^ {2}"([^"]+)":/.exec(line);
    if (top) current = top[1];
    else if (/^[}\]]/.test(line) || /^[{[]/.test(line)) current = undefined;
    return { text: line, key: current };
  });
}

/** Top-level keys the stage added or rewrote, compared by serialised value. */
function changedKeys(input: unknown, output: unknown): Set<string> {
  const changed = new Set<string>();
  if (!isRecord(output) || !isRecord(input)) return changed;

  const before = input;
  // No shared key: a different kind of document (a verdict, not a revision), so mark none.
  const overlaps = Object.keys(output).some((key) => key in before);
  if (!overlaps) return changed;

  for (const [key, value] of Object.entries(output)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed.add(key);
  }
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `estimatedCostUsd` → "Estimated cost usd". */
function label(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
