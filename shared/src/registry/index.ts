import type { ModelUse } from '@sketch-to-product-views/contracts';
import type { ModelEntry } from './schema.js';
import generated from './generated/models.json' with { type: 'json' };

export * from './schema.js';

/**
 * The registry is a compiled artifact, already validated by `codegen.ts`, so reading it
 * here is a plain import with no parse cost and no failure mode at cold start.
 */
const MODELS = generated as unknown as ModelEntry[];

const byId = new Map(MODELS.map((m) => [m.id, m]));

export function allModels(): ModelEntry[] {
  return MODELS;
}

export function modelById(id: string): ModelEntry {
  const found = byId.get(id);
  if (!found) {
    throw new Error(`unknown model: ${id}. Known: ${[...byId.keys()].join(', ')}`);
  }
  return found;
}

/**
 * Lookup that tolerates a miss. `modelById` throws because an internal caller asking for
 * a model that does not exist is a bug; a *client* naming an unknown model is a 400, and
 * the API needs to say so without an exception in the middle of request handling.
 */
export function findModel(id: string): ModelEntry | undefined {
  return byId.get(id);
}

export function modelsByCategory(category: ModelEntry['category']): ModelEntry[] {
  return MODELS.filter((m) => m.category === category);
}

export function defaultFor(category: ModelEntry['category']): ModelEntry {
  const found = MODELS.find((m) => m.category === category && m.isDefault);
  if (!found) throw new Error(`no default model for category: ${category}`);
  return found;
}

/**
 * Resolves the model a stage should use: an explicit override if given, otherwise the
 * category default. Kept in one place so no stage grows its own fallback logic.
 */
export function resolveModel(category: ModelEntry['category'], override?: string): ModelEntry {
  const entry = override ? modelById(override) : defaultFor(category);
  if (entry.category !== category) {
    throw new Error(`model ${entry.id} is ${entry.category}, not ${category}`);
  }
  return entry;
}

/**
 * The registry id Terraform set (`ANALYSER_MODEL`, `IMAGE_MODEL`), else the category default. An
 * unknown or wrong-category id throws rather than calling a model nobody chose.
 */
export function deployedModel(
  category: ModelEntry['category'],
  value: string | undefined,
): ModelEntry {
  return resolveModel(category, value?.trim() || undefined);
}

/**
 * The four registry fields a run records about a call it made.
 *
 * One place, so no stage hand-assembles it or records a different subset: image generation
 * used to write the entry id and the critic the Bedrock id, so the two could not be shown the
 * same way.
 */
/** A numeric param's registry default, or `fallback` when the entry does not declare one. */
export function numericParam(entry: ModelEntry, key: string, fallback: number): number {
  const value = entry.params.find((p) => p.key === key)?.default;
  return typeof value === 'number' ? value : fallback;
}

/**
 * A select param's value for a call: the override when it names one of the entry's options,
 * else the registry default (undefined when the entry has no such param). An override the entry
 * does not offer throws, naming the options: the provider would otherwise reject it after the
 * call was paid for, or quietly ignore it.
 */
export function selectParam(entry: ModelEntry, key: string, override?: string): string | undefined {
  const param = entry.params.find((p) => p.key === key);
  const value = override?.trim();
  if (!value) return typeof param?.default === 'string' ? param.default : undefined;
  const options = (param?.options ?? []).map((o) => o.value);
  if (!options.includes(value)) {
    const offered = options.length > 0 ? `; options: ${options.join(', ')}` : '';
    throw new Error(`${entry.id} does not offer ${key} "${value}"${offered}`);
  }
  return value;
}

export function modelUse(entry: ModelEntry): ModelUse {
  return {
    id: entry.id,
    name: entry.name,
    bedrockModelId: entry.bedrockModelId,
    region: entry.region,
  };
}

/**
 * Builds a provider request body from canonical inputs, dropping anything the model
 * does not declare a field for.
 *
 * This is the seam that lets image generation stay provider-agnostic: it passes `sketch`, and
 * whether that lands in `image` or `init_image` is the registry's problem.
 */
export function toProviderBody(
  entry: ModelEntry,
  inputs: Record<string, string | number | boolean | undefined>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  // Own properties only: a key such as `__proto__` never reaches the prototype.
  const fieldFor = (key: string): string | undefined =>
    Object.hasOwn(entry.apiFieldMap, key) ? entry.apiFieldMap[key] : undefined;
  const set = (field: string, value: unknown): void => {
    Object.defineProperty(body, field, { value, enumerable: true, writable: true, configurable: true });
  };

  // Declared defaults first, so an omitted param still travels explicitly rather than
  // relying on whatever the provider happens to default to today.
  for (const param of entry.params) {
    if (param.default !== undefined)
      set(fieldFor(param.key) ?? param.key, param.default);
  }

  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined) continue;
    const field = fieldFor(key);
    if (!field) continue;
    set(field, value);
  }

  for (const required of entry.requiredInputs) {
    const field = fieldFor(required) ?? required;
    if (!Object.hasOwn(body, field) || body[field] === undefined) {
      throw new Error(`${entry.id}: missing required input "${required}"`);
    }
  }

  return body;
}
