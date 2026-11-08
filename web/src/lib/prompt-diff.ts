/**
 * Word-level diff between two prompts.
 *
 * A retry appends the critic's issues to the prompt, so attempt 2 is usually
 * attempt 1 plus a correction clause. Showing the two prompts side by side makes the
 * reader hunt for the change; marking it makes the feedback loop the point.
 *
 * Whitespace-delimited tokens rather than characters: a character diff on a sentence that
 * gained a clause highlights fragments of words and reads as noise.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffToken {
  text: string;
  kind: DiffKind;
}

/**
 * Standard LCS table. A prompt is a few hundred words, so the quadratic table stays in the
 * hundreds of thousands of cells: not worth a smarter algorithm.
 */
export function diffPrompts(before: string, after: string): DiffToken[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  const push = (text: string, kind: DiffKind) => {
    const last = tokens[tokens.length - 1];
    // Merge runs so a whole inserted clause renders as one highlight, not one per word.
    if (last && last.kind === kind) last.text += ` ${text}`;
    else tokens.push({ text, kind });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i], 'same');
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], 'removed');
      i += 1;
    } else {
      push(b[j], 'added');
      j += 1;
    }
  }
  while (i < a.length) {
    push(a[i], 'removed');
    i += 1;
  }
  while (j < b.length) {
    push(b[j], 'added');
    j += 1;
  }

  return tokens;
}
