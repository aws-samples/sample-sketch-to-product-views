import { imageCallTimeout, keySource, type OpenAICompatibleConfig } from '../openai/compatible.js';

/**
 * A LiteLLM gateway, reached with a virtual key: `LITELLM_API_KEY`, else the secret
 * named by `LITELLM_API_KEY_SECRET_ARN`.
 */

export const DEFAULT_LITELLM_BASE_URL = 'https://litellm.example.internal';

export type LiteLLMConfig = OpenAICompatibleConfig;

export function litellmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiteLLMConfig {
  const baseUrl = (env.LITELLM_BASE_URL?.trim() || DEFAULT_LITELLM_BASE_URL).replace(/\/+$/, '');
  const apiKey = keySource(
    'LiteLLM',
    { direct: 'LITELLM_API_KEY', secret: 'LITELLM_API_KEY_SECRET_ARN' }, // pragma: allowlist secret
    env,
  );
  return {
    baseUrl,
    apiKey,
    fetch: globalThis.fetch,
    timeoutMs: imageCallTimeout(env),
    provider: 'litellm',
  };
}

export {
  LiteLLMError,
  ProviderAccessError,
  ProviderHttpError,
  gatewayReason,
} from '../openai/compatible.js';
