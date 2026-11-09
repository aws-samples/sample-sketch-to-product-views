import { resolveModel, unsupportedProvider, type ModelProvider } from '../registry/index.js';
import { createLiteLLMImageGenerator, createOpenAIImageGenerator } from './openai-image.js';
import type { ImageGenerator } from './types.js';

/** Providers with an image adapter. Bedrock has no multi-reference image model. */
export type ImageProvider = Exclude<ModelProvider, 'bedrock'>;

/** Exhaustive, so a provider with no adapter throws instead of falling through. */
export function adapterFor(
  entry: { id: string; provider: ModelProvider },
  adapters: Record<ImageProvider, ImageGenerator>,
): ImageGenerator {
  switch (entry.provider) {
    case 'bedrock':
      throw new Error(
        `${entry.id}: no Bedrock image adapter; Bedrock serves the analyser and critic`,
      );
    case 'litellm':
      return adapters.litellm;
    case 'openai':
      return adapters.openai;
    default:
      return unsupportedProvider(entry.id, entry.provider);
  }
}

/**
 * The generator the pipeline uses: the registry entry's `provider` picks the
 * adapter, so switching models is a registry id, never a code path.
 */
export function createImageGenerator(
  adapters: Partial<Record<ImageProvider, ImageGenerator>> = {},
): ImageGenerator {
  const all: Record<ImageProvider, ImageGenerator> = {
    litellm: adapters.litellm ?? createLiteLLMImageGenerator(),
    openai: adapters.openai ?? createOpenAIImageGenerator(),
  };
  return {
    generate(request) {
      const entry = resolveModel('image-control', request.modelId);
      return adapterFor(entry, all).generate({ ...request, modelId: entry.id });
    },
  };
}
