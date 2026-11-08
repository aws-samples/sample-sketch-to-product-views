import type { ModelEntry } from '../registry/schema.js';
import { imageCallTimeout, keySource, type OpenAICompatibleConfig } from './compatible.js';

/**
 * OpenAI's API called directly with a project API key.
 *
 * The base URL is `https://${entry.region}`: the entry's `region` is the API host, so the
 * registry, not the environment, decides where the payload is processed. `OPENAI_BASE_URL`
 * overrides it for tests and proxies only, for every `openai` entry alike.
 *
 * `OPENAI_ORGANIZATION` and `OPENAI_PROJECT` travel as the `OpenAI-Organization` and
 * `OpenAI-Project` headers (https://developers.openai.com/api/reference/overview).
 */

export type OpenAIConfig = OpenAICompatibleConfig;

export interface OpenAIConfigDeps {
  fetch?: typeof fetch;
  /** Reads a key secret by ARN; omitted means Secrets Manager, cached per process. */
  readSecret?: (arn: string) => Promise<string>;
}

export function openaiConfigFromEnv(
  entry: Pick<ModelEntry, 'id' | 'provider' | 'region'>,
  env: NodeJS.ProcessEnv = process.env,
  deps: OpenAIConfigDeps = {},
): OpenAIConfig {
  if (entry.provider !== 'openai') {
    throw new Error(`${entry.id} is a ${entry.provider} model, not an OpenAI one`);
  }
  const override = env.OPENAI_BASE_URL?.trim();
  let baseUrl = override || `https://${entry.region}`;
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const headers: Record<string, string> = {};
  const organization = env.OPENAI_ORGANIZATION?.trim();
  const project = env.OPENAI_PROJECT?.trim();
  if (organization) headers['OpenAI-Organization'] = organization;
  if (project) headers['OpenAI-Project'] = project;

  const apiKey = keySource(
    'OpenAI',
    { direct: 'OPENAI_API_KEY', secret: 'OPENAI_API_KEY_SECRET_ARN' }, // pragma: allowlist secret
    env,
    deps.readSecret,
  );

  return {
    baseUrl,
    apiKey,
    fetch: deps.fetch ?? globalThis.fetch,
    timeoutMs: imageCallTimeout(env),
    headers,
    provider: 'openai',
  };
}

export { OpenAIError, ProviderAccessError } from './compatible.js';
