/**
 * Image generation only: the dispatch seam, the OpenAI-compatible adapters (LiteLLM gateway,
 * direct OpenAI) and the prompt builder.
 *
 * A separate entry point (`@sketch-to-product-views/shared/generate`) for the same reason as `./store`:
 * the root index re-exports the qc tier, which pulls in `sharp`. The pipeline needs to
 * generate images without shipping a native binary, so it imports this instead.
 */
export * from './types.js';
export * from './openai-image.js';
export * from './dispatch.js';
export * from './prompt.js';
export * from './views.js';
export {
  LiteLLMError,
  OpenAIError,
  ProviderAccessError,
  ProviderHttpError,
} from '../openai/compatible.js';
