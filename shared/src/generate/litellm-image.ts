/**
 * The LiteLLM image adapter is the OpenAI-compatible one (`openai-image.ts`) with the gateway's
 * config; re-exported under its original path so existing imports keep working.
 */
export { createLiteLLMImageGenerator } from './openai-image.js';
