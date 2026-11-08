import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import {
  GUARDRAIL_STOP,
  GuardrailBlockedError,
  converseGuardrailConfig,
  guardrailFromEnv,
  systemBlocks,
  type GuardrailRef,
} from '../../guardrail/index.js';
import { numericParam } from '../../registry/index.js';
import { parseJson, stripFence } from '../json.js';
import type { ModelEntry } from '../../registry/index.js';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ImageInput {
  bytes: Uint8Array;
  format: ImageFormat;
}

/** One structured-output call on one or more labelled images. */
export interface CriticRequest {
  /** Names the call in errors, e.g. `comparison`. */
  purpose: string;
  entry: ModelEntry;
  system: string;
  /** User-supplied text inside `system` (facts, requests), in `guardContent` with a guardrail. */
  guarded?: readonly string[];
  /** Sent in order, each after a text block `{label}:`. */
  images: readonly { label: string; image: ImageInput }[];
  schema: z.ZodType;
  /** A floor under the entry's `max_tokens`, for an answer known to be long. */
  minOutputTokens?: number;
  /** Overrides the entry's `temperature` for this call. */
  temperature?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CriticResponse {
  output: unknown;
  usage: Usage;
}

/** `createConverseRunner` is the real one; tests pass a fake. */
export type CriticRunner = (request: CriticRequest) => Promise<CriticResponse>;

/** One answer plus two corrections. */
export const MAX_TURNS = 3;

/** A new schema's first call compiles its grammar, up to ~90 s (structured-output docs). */
export const CRITIC_TIMEOUT_MS = 120_000;

export interface ConverseRunnerDeps {
  clientFor?: (region: string) => Pick<BedrockRuntimeClient, 'send'>;
  /** Defaults to `guardrailFromEnv()`; `null` turns it off. */
  guardrail?: GuardrailRef | null;
}

const clients = new Map<string, BedrockRuntimeClient>();

/** One retry on a transient fault, then the stage retries; a timeout throws. */
function criticBedrockFor(region: string): BedrockRuntimeClient {
  let client = clients.get(region);
  if (!client) {
    client = new BedrockRuntimeClient({
      region,
      maxAttempts: 2,
      requestHandler: { requestTimeout: CRITIC_TIMEOUT_MS, throwOnRequestTimeout: true },
    });
    clients.set(region, client);
  }
  return client;
}

/**
 * Keywords Bedrock structured output rejects with a 400; zod still checks them on the answer.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html
 */
const UNSUPPORTED = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
]);

export function bedrockJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bedrockJsonSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, v]) => !UNSUPPORTED.has(key) && !(key === 'minItems' && Number(v) > 1))
      .map(([key, v]) => [key, bedrockJsonSchema(v)]),
  );
}

const issuesOf = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

/**
 * One Converse call per request. Structured output (`outputConfig.textFormat`) when the entry
 * supports it, else the schema in the system prompt. An answer that fails the zod schema gets
 * a correction turn, up to `MAX_TURNS` calls.
 */
export function createConverseRunner(deps: ConverseRunnerDeps = {}): CriticRunner {
  const clientFor = deps.clientFor ?? criticBedrockFor;

  return async (request) => {
    const { purpose, entry, system, images, schema, minOutputTokens = 0, temperature } = request;
    const guardrail = deps.guardrail === undefined ? guardrailFromEnv() : deps.guardrail;
    const jsonSchema = z.toJSONSchema(schema);
    const prompt = entry.structuredOutput
      ? system
      : `${system}\n\nAnswer with one JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
    const client = clientFor(entry.region);
    const messages: Message[] = [
      {
        role: 'user',
        content: images.flatMap(({ label, image }) => [
          { text: `${label}:` },
          { image: { format: image.format, source: { bytes: image.bytes } } },
        ]),
      },
    ];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let issues = '';

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response: ConverseCommandOutput = await client.send(
        new ConverseCommand({
          modelId: entry.bedrockModelId,
          // With a guardrail, only the user text in the system prompt is wrapped; the messages
          // hold labels and images, which a text-only filter does not read as content.
          system: guardrail ? systemBlocks(prompt, request.guarded ?? []) : [{ text: prompt }],
          messages,
          inferenceConfig: {
            maxTokens: Math.max(numericParam(entry, 'max_tokens', 4096), minOutputTokens),
            temperature: temperature ?? numericParam(entry, 'temperature', 0),
          },
          ...(entry.structuredOutput
            ? {
                outputConfig: {
                  textFormat: {
                    type: 'json_schema',
                    structure: {
                      jsonSchema: {
                        schema: JSON.stringify(bedrockJsonSchema(jsonSchema)),
                        name: 'critic_answer',
                      },
                    },
                  },
                },
              }
            : {}),
          ...(guardrail ? { guardrailConfig: converseGuardrailConfig(guardrail) } : {}),
        }),
      );
      if (response.stopReason === GUARDRAIL_STOP) {
        throw new GuardrailBlockedError(`Critic ${purpose} call`);
      }
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;

      const message = response.output?.message;
      // A reasoning model answers with a `reasoningContent` block before the text one.
      const text = message?.content?.find((b) => typeof b.text === 'string')?.text;
      if (response.stopReason !== 'end_turn' || !message || !text) {
        throw new Error(
          `${entry.id}: ${purpose} gave no structured output (${response.stopReason})`,
        );
      }

      const parsed = schema.safeParse(parseJson(stripFence(text)));
      if (parsed.success) return { output: parsed.data, usage };

      issues = issuesOf(parsed.error);
      messages.push(message, {
        role: 'user',
        content: [
          {
            text: `That answer does not match the schema (${issues}). Answer again with one corrected JSON object only.`,
          },
        ],
      });
    }

    throw new Error(`${entry.id}: ${purpose} did not match its schema`, {
      cause: new Error(issues),
    });
  };
}
