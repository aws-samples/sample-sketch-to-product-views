import {
  isSketchSourced,
  isSpecSourced,
  aspectDef,
  type AspectDef,
  type AttributeResult,
  type Evaluation,
} from '@sketch-to-product-views/contracts';
import { MAX_PARTS, type Answer, type AspectAnswer, type ComparisonAnswer } from './prompt.js';

/**
 * The verdict is code: a view fails only on a hard fact (the wrong object, the wrong colour, an
 * unusable image), every other difference warns, and `cant_tell` never counts.
 */

/** Below this, the image is one a reviewer would reject. */
export const MIN_IMAGE_QUALITY = 0.5;

/** What a view can fail on; `presentation` is the usable-image check. */
export type HardFact = 'object_type' | 'color' | 'presentation';

const WEIGHT = { must: 3, should: 2, nice: 1 } as const;
const MAX_ISSUES = 8;
const MAX_PROBLEMS = 6;

const OUTCOME: Record<Answer, AttributeResult['outcome']> = {
  same: 'match',
  different: 'mismatch',
  cant_tell: 'skipped',
};

/** The hard facts this answer fails, in a fixed order. */
export function hardFails(answer: ComparisonAnswer): HardFact[] {
  const fails: HardFact[] = [];
  for (const name of ['object_type', 'color'] as const) {
    if (answer.aspects[name]?.answer === 'different') fails.push(name);
  }
  if (!answer.image.usable || clamp(answer.image.imageQuality) < MIN_IMAGE_QUALITY) {
    fails.push('presentation');
  }
  return fails;
}

export interface Judgement {
  verdict: Evaluation['verdict'];
  scores: Evaluation['scores'];
  issues: string[];
  attributes: AttributeResult[];
  confirmation?: { failedOn: HardFact[]; confirmed: HardFact[] };
}

interface Difference {
  rank: number;
  text: string;
}

/**
 * The verdict from the first answer and, when that one failed the view, a second reading of
 * the same request: only the facts both fail on fail the view, the rest warn.
 */
export function judge(
  first: ComparisonAnswer,
  asked: readonly AspectDef[],
  second?: ComparisonAnswer,
): Judgement {
  const failedOn = hardFails(first);
  const confirmed = second ? failedOn.filter((f) => hardFails(second).includes(f)) : failedOn;
  const doubted = (name: string) =>
    failedOn.includes(name as HardFact) && !confirmed.includes(name as HardFact);

  const attributes: AttributeResult[] = [];
  const differences: Difference[] = [];
  const sketch = { hit: 0, total: 0 };
  const spec = { hit: 0, total: 0 };
  const score = (def: AspectDef, hit: number, total: number) => {
    for (const bucket of [isSketchSourced(def) && sketch, isSpecSourced(def) && spec]) {
      if (!bucket) continue;
      bucket.total += WEIGHT[def.weight] * total;
      bucket.hit += WEIGHT[def.weight] * hit;
    }
  };
  const record = (name: string, a: AspectAnswer, rank: number) => {
    attributes.push({
      attribute: name,
      expected: a.reference,
      observed: a.observed,
      outcome: OUTCOME[a.answer],
      confidence: a.answer === 'cant_tell' ? 0 : doubted(name) ? 0.5 : 1,
      reason: a.reason,
    });
    if (a.answer === 'different') {
      const doubt = doubted(name) ? '; a second reading disagreed' : '';
      differences.push({
        rank,
        text: `${name}: expected ${a.reference}, observed ${a.observed} (${a.reason}${doubt})`,
      });
    }
  };

  for (const def of asked) {
    const a = first.aspects[def.name];
    if (!a) continue;
    // A confirmed hard fact ranks first, so a retry passes it on.
    record(def.name, a, confirmed.includes(def.name as HardFact) ? 10 : WEIGHT[def.weight]);
    if (a.answer !== 'cant_tell') score(def, a.answer === 'same' ? 1 : 0, 1);
  }

  // The parts count once, as the share of answered parts that are the same.
  const parts = (first.parts ?? []).slice(0, MAX_PARTS);
  const partsDef = aspectDef('parts');
  for (const p of parts) record(`part: ${p.part}`, p, WEIGHT[partsDef.weight]);
  const answered = parts.filter((p) => p.answer !== 'cant_tell');
  if (answered.length > 0) {
    score(partsDef, answered.filter((p) => p.answer === 'same').length / answered.length, 1);
  }

  const imageQuality = clamp(first.image.imageQuality);
  const usable = !failedOn.includes('presentation');
  attributes.push({
    attribute: 'presentation',
    expected: 'a usable studio product image',
    observed: first.image.usable
      ? `usable, quality ${imageQuality.toFixed(2)}`
      : 'not a usable studio product image',
    outcome: usable ? 'match' : 'mismatch',
    confidence: doubted('presentation') ? 0.5 : 1,
  });
  if (!usable) {
    differences.push({
      rank: confirmed.includes('presentation') ? 11 : WEIGHT.must,
      text: `presentation: ${first.image.usable ? `image quality ${imageQuality.toFixed(2)}, under ${MIN_IMAGE_QUALITY}` : 'not a usable studio product image'}${doubted('presentation') ? ' (a second reading disagreed)' : ''}`,
    });
  }

  const ordered = differences.sort((a, b) => b.rank - a.rank).map((d) => d.text);
  return {
    verdict: confirmed.length > 0 ? 'fail' : differences.length > 0 ? 'warn' : 'pass',
    scores: { sketchFidelity: ratio(sketch), specAdherence: ratio(spec), imageQuality },
    issues: [...ordered, ...first.image.problems.slice(0, MAX_PROBLEMS)].slice(0, MAX_ISSUES),
    attributes,
    ...(second ? { confirmation: { failedOn, confirmed } } : {}),
  };
}

/** Nothing compared means nothing contradicted: the score stays at 1. */
function ratio({ hit, total }: { hit: number; total: number }): number {
  return total === 0 ? 1 : hit / total;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}
