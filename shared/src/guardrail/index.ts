import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  type ApplyGuardrailCommandOutput,
  type ContentBlock,
  type GuardrailAssessment,
  type GuardrailConfiguration,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Amazon Bedrock Guardrails, used two ways:
 *
 *  - on every Converse call, as `guardrailConfig`, with only the user-written text wrapped in
 *    `guardContent` blocks, so the prompt-attack filter reads user input and not our prompts
 *    (https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html);
 *  - standalone, with `ApplyGuardrail` (source INPUT), on text bound for a model outside Bedrock
 *    (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ApplyGuardrail.html).
 *
 * Off when `GUARDRAIL_ID` is unset: every call then runs as before.
 */

export interface GuardrailRef {
  id: string;
  version: string;
}

/** `GUARDRAIL_ID` and `GUARDRAIL_VERSION`; undefined when the id is unset or blank. */
export function guardrailFromEnv(env: NodeJS.ProcessEnv = process.env): GuardrailRef | undefined {
  const id = env.GUARDRAIL_ID?.trim();
  if (!id) return undefined;
  const version = env.GUARDRAIL_VERSION?.trim();
  if (!version) throw new Error('GUARDRAIL_VERSION must be set when GUARDRAIL_ID is');
  return { id, version };
}

/** The one line a deployment without a guardrail logs at start. */
export const GUARDRAIL_OFF_WARNING =
  'guardrail off: GUARDRAIL_ID is not set; free text is sanitised but not screened';

/**
 * Terminal: the guardrail blocked user text, or a model call. The message names the input and
 * the policies, never the text itself.
 */
export class GuardrailBlockedError extends Error {
  override name = 'GuardrailBlockedError';
  constructor(
    readonly subject: string,
    readonly policies: readonly string[] = [],
  ) {
    super(
      `${subject}: blocked by the content guardrail${policies.length > 0 ? ` (${policies.join(', ')})` : ''}.`,
    );
  }
}

// ── Converse ────────────────────────────────────────────────────────────────

/** Trace off: a block is reported by its stop reason, and nothing it matched is returned. */
export function converseGuardrailConfig(ref: GuardrailRef): GuardrailConfiguration {
  return { guardrailIdentifier: ref.id, guardrailVersion: ref.version, trace: 'disabled' };
}

type TextOrGuard = { text: string } | { guardContent: { text: { text: string } } };

/**
 * `text` as blocks, each occurrence of a `guarded` string (user-written text) in a
 * `guardContent` block and the rest as plain text. Concatenated, the blocks are `text`.
 */
export function guardedBlocks(text: string, guarded: readonly string[]): TextOrGuard[] {
  const needles = [...new Set(guarded.filter((g) => g.length > 0))];
  const blocks: TextOrGuard[] = [];
  let rest = text;
  for (;;) {
    let at = -1;
    let needle = '';
    for (const n of needles) {
      const i = rest.indexOf(n);
      // The earliest match; the longer one when two start together.
      if (i >= 0 && (at < 0 || i < at || (i === at && n.length > needle.length))) {
        at = i;
        needle = n;
      }
    }
    if (at < 0) break;
    if (at > 0) blocks.push({ text: rest.slice(0, at) });
    blocks.push({ guardContent: { text: { text: needle } } });
    rest = rest.slice(at + needle.length);
  }
  if (rest.length > 0) blocks.push({ text: rest });
  return blocks;
}

export const messageBlocks = (text: string, guarded: readonly string[]) =>
  guardedBlocks(text, guarded) as ContentBlock[];

export const systemBlocks = (text: string, guarded: readonly string[]) =>
  guardedBlocks(text, guarded) as SystemContentBlock[];

/** Bedrock's stop reason when a guardrail blocked the input or the answer. */
export const GUARDRAIL_STOP = 'guardrail_intervened';

// ── ApplyGuardrail ──────────────────────────────────────────────────────────

export interface ScreenField {
  /** Names what was screened, e.g. `Design notes`; a block reports this, never the text. */
  label: string;
  text: string;
}

export interface ScreenDeps {
  /** Defaults to `guardrailFromEnv()`; `null` turns screening off. */
  guardrail?: GuardrailRef | null;
  client?: Pick<BedrockRuntimeClient, 'send'>;
}

export interface ScreenResult {
  /** False when no guardrail is configured. */
  screened: boolean;
  fields: number;
}

let defaultClient: BedrockRuntimeClient | undefined;

/** In the guardrail's Region, the function's own; a few SDK attempts, each at most 10 s. */
const screenClient = () =>
  (defaultClient ??= new BedrockRuntimeClient({
    maxAttempts: 2,
    requestHandler: { requestTimeout: 10_000, throwOnRequestTimeout: true },
  }));

/**
 * Screens each field, as an input, with one `ApplyGuardrail` call per field (in parallel), so a
 * block names the field. Throws `GuardrailBlockedError` for the first blocked field.
 */
export async function screenText(
  fields: readonly ScreenField[],
  deps: ScreenDeps = {},
): Promise<ScreenResult> {
  const guardrail = deps.guardrail === undefined ? guardrailFromEnv() : deps.guardrail;
  const present = fields.filter((f) => f.text.trim().length > 0);
  if (!guardrail || present.length === 0) return { screened: Boolean(guardrail), fields: 0 };

  const client = deps.client ?? screenClient();
  const results = await Promise.all(
    present.map(async (field) => {
      const output: ApplyGuardrailCommandOutput = await client.send(
        new ApplyGuardrailCommand({
          guardrailIdentifier: guardrail.id,
          guardrailVersion: guardrail.version,
          source: 'INPUT',
          content: [{ text: { text: field.text } }],
        }),
      );
      return { field, output };
    }),
  );
  const blocked = results.find((r) => r.output.action === 'GUARDRAIL_INTERVENED');
  if (blocked) {
    throw new GuardrailBlockedError(blocked.field.label, policiesOf(blocked.output.assessments));
  }
  return { screened: true, fields: present.length };
}

const FILTER_NAMES: Record<string, string> = {
  PROMPT_ATTACK: 'prompt attack',
  HATE: 'hate',
  INSULTS: 'insults',
  SEXUAL: 'sexual',
  VIOLENCE: 'violence',
  MISCONDUCT: 'misconduct',
};

/** The policies that blocked, by name, from the assessments; no matched text. */
export function policiesOf(assessments: readonly GuardrailAssessment[] = []): string[] {
  const names = assessments.flatMap((a) => [
    ...(a.contentPolicy?.filters ?? [])
      .filter((f) => f.action === 'BLOCKED')
      .map((f) => FILTER_NAMES[f.type ?? ''] ?? String(f.type).toLowerCase()),
    ...(a.topicPolicy?.topics ?? [])
      .filter((t) => t.action === 'BLOCKED')
      .map((t) => `denied topic ${t.name}`),
    ...((a.wordPolicy?.customWords ?? []).some((w) => w.action === 'BLOCKED') ||
    (a.wordPolicy?.managedWordLists ?? []).some((w) => w.action === 'BLOCKED')
      ? ['word filter']
      : []),
    ...((a.sensitiveInformationPolicy?.piiEntities ?? []).some((p) => p.action === 'BLOCKED') ||
    (a.sensitiveInformationPolicy?.regexes ?? []).some((r) => r.action === 'BLOCKED')
      ? ['sensitive information']
      : []),
  ]);
  return [...new Set(names)];
}
