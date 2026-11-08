import { z } from 'zod';
import { litellmConfigFromEnv } from '../litellm/client.js';
import { openaiConfigFromEnv } from '../openai/client.js';
import {
  authHeaders,
  classifyFailure,
  refusalText,
  type CompatibleProvider,
  type OpenAICompatibleConfig,
} from '../openai/compatible.js';
import { resolveModel, toProviderBody, type ModelEntry } from '../registry/index.js';
import {
  ContentRefusedError,
  type GenerationRequest,
  type GenerationResult,
  type ImageGenerator,
} from './types.js';

/**
 * OpenAI image models through `/v1/images/edits`, behind a LiteLLM gateway or on OpenAI's
 * API directly: the sketch goes in as the reference image. Multipart field names come from the
 * registry's `apiFieldMap`.
 *
 * The sketch first, then any reference image (the material sample). OpenAI accepts up to 16 input
 * images
 * (https://developers.openai.com/api/reference/python/resources/images/methods/edit). GPT image
 * models always answer in base64 (`data[].b64_json`).
 */
const responseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});

/**
 * `configFor` is asked per call because a direct OpenAI entry's host is its registry `region`;
 * the gateway has one config for every entry.
 */
export function createOpenAICompatibleImageGenerator(
  provider: CompatibleProvider,
  configFor: (entry: ModelEntry) => OpenAICompatibleConfig,
): ImageGenerator {
  return {
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      const entry = resolveModel('image-control', request.modelId);
      if (entry.provider !== provider) {
        const expected = provider === 'openai' ? 'an OpenAI' : 'a LiteLLM';
        throw new Error(`${entry.id} is a ${entry.provider} model, not ${expected} one`);
      }
      const config = configFor(entry);

      // The sketch travels as a file part, not a field: the placeholder only satisfies the
      // registry's required-input check and is replaced below.
      const fields = toProviderBody(entry, {
        prompt: request.prompt,
        sketch: 'file',
        ...request.params,
      });
      const sketchField = entry.apiFieldMap.sketch ?? 'image';

      const form = new FormData();
      form.append('model', entry.bedrockModelId);
      for (const [name, value] of Object.entries(fields)) {
        if (name === sketchField || value === undefined || value === null || value === '') continue;
        form.append(name, String(value));
      }
      // Several images, sketch first: OpenAI rejects a repeated `image` part and wants `image[]`;
      // the gateway rejects `image[]` (it forwards those parts as strings) and takes repeats.
      const images = [request.sketch, ...(request.references ?? [])];
      const imageField =
        provider === 'openai' && images.length > 1 ? `${sketchField}[]` : sketchField;
      images.forEach((bytes, i) => {
        const type = sniffImageType(bytes) ?? 'image/png';
        form.append(
          imageField,
          new Blob([new Uint8Array(bytes)], { type }),
          `${i === 0 ? 'sketch' : `reference-${i}`}.${type.split('/')[1]}`,
        );
      });

      const started = Date.now();
      const response = await config.fetch(`${config.baseUrl}/v1/images/edits`, {
        method: 'POST',
        headers: await authHeaders(config),
        body: form,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const durationMs = Date.now() - started;
      const text = await response.text();

      if (!response.ok) {
        const failure = classifyFailure(config, entry.id, response, text);
        if (failure.kind === 'refused') {
          throw new ContentRefusedError(`${entry.id}: ${refusalText(failure)}`);
        }
        throw failure.error;
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`${entry.id}: unrecognised response shape from ${entry.bedrockModelId}`);
      }

      const image = new Uint8Array(Buffer.from(parsed.data.data[0].b64_json, 'base64'));
      return {
        image,
        contentType: sniffImageType(image) ?? 'image/png',
        model: { id: entry.id, bedrockModelId: entry.bedrockModelId, region: entry.region },
        durationMs,
      };
    },
  };
}

export function createLiteLLMImageGenerator(
  config: OpenAICompatibleConfig = litellmConfigFromEnv(),
): ImageGenerator {
  return createOpenAICompatibleImageGenerator('litellm', () => config);
}

export function createOpenAIImageGenerator(
  configFor: (entry: ModelEntry) => OpenAICompatibleConfig = (entry) => openaiConfigFromEnv(entry),
): ImageGenerator {
  return createOpenAICompatibleImageGenerator('openai', configFor);
}

function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}
