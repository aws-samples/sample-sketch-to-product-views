import sharp from 'sharp';
import type { Evaluation } from '@sketch-to-product-views/contracts';
import { modelUse, resolveModel, type ModelEntry } from '../../registry/index.js';
import { imageFormat, type Critic, type CriticInput } from '../critic.js';
import { checkRequests } from './requests.js';
import {
  createConverseRunner,
  type CriticRequest,
  type CriticRunner,
  type ImageInput,
} from './converse.js';
import {
  askedAspects,
  asksParts,
  comparisonPrompt,
  comparisonSchema,
  suppliedFacts,
  type ComparisonAnswer,
} from './prompt.js';
import { hardFails, judge } from './verdict.js';

export * from './requests.js';
export * from './converse.js';
export * from './prompt.js';
export * from './verdict.js';

/** The stored label of the judge's evaluations. */
export const JUDGE_REVIEWER = 'judge';

export interface JudgeCriticOptions {
  runner?: CriticRunner;
}

/** Six aspects and up to twelve parts, each with a reason, run past 1024 tokens. */
export const COMPARISON_MIN_TOKENS = 3072;

/**
 * The confirmation call's temperature, so it is an independent reading rather than a replay of
 * the first (Converse accepts 0 to 1). `critic:measure` reports how often the second call agrees.
 */
export const CONFIRMATION_TEMPERATURE = 0.7;

/**
 * The longest side an image is sent at. Claude reads an image at 1568 px at most and scales a
 * larger one down itself (https://docs.claude.com/en/docs/build-with-claude/vision), and Bedrock
 * refuses one over 5 MB: a 1536x2304 PNG view is 5.7 MB.
 */
export const MODEL_IMAGE_SIDE = 1568;

/**
 * An image as the critic's model takes it: within `MODEL_IMAGE_SIDE`, as a JPEG. One that already
 * fits and is small is sent as it is.
 */
export async function modelImage(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { width = 0, height = 0 } = await sharp(bytes).metadata();
  if (Math.max(width, height) <= MODEL_IMAGE_SIDE && bytes.byteLength <= 3_000_000) {
    return { bytes, contentType };
  }
  const resized = await sharp(bytes)
    .resize(MODEL_IMAGE_SIDE, MODEL_IMAGE_SIDE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes: new Uint8Array(resized), contentType: 'image/jpeg' };
}

/**
 * The critic: one call compares the generated view with the sketch, the material sample and
 * the supplied facts, aspect by aspect (`comparisonPrompt`), and `judge` decides. A view
 * that would fail is asked once more with the same request at `CONFIRMATION_TEMPERATURE`, and
 * fails only on what both answers fail on: a call costs cents, a needless regeneration far more.
 *
 * After a regeneration, the aspects the reviewer's description changes are not asked, and
 * each request for the view is checked on the candidate (`checkRequests`): one confidently not
 * applied fails it, one doubtfully not applied warns.
 */
export function createJudgeCritic(options: JudgeCriticOptions = {}): Critic {
  const runner = options.runner ?? createConverseRunner();

  return {
    async evaluate(input: CriticInput): Promise<Evaluation> {
      const entry = resolveModel('critic', input.modelId);
      const prepare = async (bytes: Uint8Array, type: string): Promise<ImageInput> => {
        const sent = await modelImage(bytes, type);
        return { bytes: sent.bytes, format: imageFormat(sent.contentType) };
      };
      const [sketch, candidate, swatch] = await Promise.all([
        prepare(input.sketch, input.sketchContentType),
        prepare(input.candidate, input.candidateContentType),
        input.swatch && input.swatchContentType
          ? prepare(input.swatch, input.swatchContentType)
          : undefined,
      ]);

      const request = comparisonRequest(entry, input, { sketch, candidate, swatch });
      const requests = input.requests ?? [];
      const [first, check] = await Promise.all([
        compareOnce(runner, request),
        requests.length > 0
          ? checkRequests(candidate, requests, { entry, runner, view: input.view })
          : undefined,
      ]);
      const second =
        hardFails(first).length > 0
          ? await compareOnce(runner, { ...request, temperature: CONFIRMATION_TEMPERATURE })
          : undefined;
      const result = judge(first, request.asked, second);

      const missed = check?.missed ?? [];
      // A missed request can only lower a verdict.
      const verdict = missed.some((m) => m.confident)
        ? 'fail'
        : missed.length > 0 && result.verdict === 'pass'
          ? 'warn'
          : result.verdict;

      return {
        verdict,
        scores: result.scores,
        // First, so they are among the findings a retry passes on.
        issues: [
          ...missed.map((m) => `requested change not applied: ${m.request} (${m.note})`),
          ...result.issues,
        ],
        reviewer: JUDGE_REVIEWER,
        model: modelUse(entry),
        attributes: result.attributes,
        ...(result.confirmation ? { confirmation: result.confirmation } : {}),
      };
    },
  };
}

/** The one request a view is judged with, and the attributes it asks about. */
export function comparisonRequest(
  entry: ModelEntry,
  input: Pick<CriticInput, 'spec' | 'view' | 'changed' | 'sketchKind'>,
  images: { sketch: ImageInput; candidate: ImageInput; swatch?: ImageInput },
): CriticRequest & { asked: ReturnType<typeof askedAspects> } {
  const ctx = {
    view: input.view,
    facts: suppliedFacts(input.spec),
    swatch: images.swatch !== undefined,
    changed: input.changed,
    ...(input.sketchKind === 'photo' ? { sketchKind: 'photo' as const } : {}),
  };
  const asked = askedAspects(ctx);
  const parts = asksParts(ctx);
  return {
    purpose: 'comparison',
    entry,
    system: comparisonPrompt({ ...ctx, aspects: asked, parts }),
    // The supplied facts, as the prompt quotes them: the only text in it a user wrote.
    guarded: Object.values(ctx.facts).map((value) => JSON.stringify(value)),
    images: [
      { label: 'Sketch', image: images.sketch },
      { label: `Generated image (${input.view ?? 'front'} view)`, image: images.candidate },
      ...(images.swatch ? [{ label: 'Material sample', image: images.swatch }] : []),
    ],
    schema: comparisonSchema(asked, parts),
    minOutputTokens: COMPARISON_MIN_TOKENS,
    asked,
  };
}

async function compareOnce(
  runner: CriticRunner,
  request: CriticRequest,
): Promise<ComparisonAnswer> {
  const response = await runner(request);
  const parsed = request.schema.safeParse(response.output);
  if (!parsed.success) {
    throw new Error(`${request.entry.id}: comparison did not match its schema`);
  }
  return parsed.data as ComparisonAnswer;
}
