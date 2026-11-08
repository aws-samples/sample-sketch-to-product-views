import { z } from 'zod';

/**
 * The model registry, forked from CreativeFlow's YAML registry and cut down to what this
 * pipeline needs.
 *
 * Two properties matter more than the field list:
 *
 *  1. **Region lives on the entry, not the call site.** The caller asks the registry for a
 *     model and gets a client pointed at the entry's endpoint; it never chooses one.
 *  2. **`params` is data, so the UI is generic.** ModelBench renders whatever a model
 *     declares. Adding a model is a YAML file, never a UI change.
 */

export const paramSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'select']),
  label: z.string().optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** Hidden behind a disclosure in ModelBench; still fully usable. */
  advanced: z.boolean().default(false),
});

export type ModelParam = z.infer<typeof paramSchema>;

export const GLOBAL_RESIDENCY = 'global';

/**
 * The hosts OpenAI serves its API from: `api.openai.com`, or a regional one such as
 * `eu.api.openai.com` (https://developers.openai.com/api/docs/guides/your-data).
 */
export const OPENAI_API_HOST = /^([a-z0-9-]+\.)?api\.openai\.com$/;

export function isGlobalProfile(entry: { provider?: string; bedrockModelId: string }): boolean {
  return (entry.provider ?? 'bedrock') === 'bedrock' && entry.bedrockModelId.startsWith('global.');
}

export const modelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),

    /**
     * `image-control` conditions generation on a sketch — the only category image
     * generation can use. `critic` is a multimodal text model scoring a candidate.
     * `analyser` reads the images and the product metadata into a structured analysis.
     */
    category: z.enum(['image-control', 'critic', 'analyser']),

    /**
     * Who serves the call. `bedrock` is an AWS model reached with the function's own role;
     * `litellm` is a model behind a LiteLLM gateway, reached with its virtual key;
     * `openai` is OpenAI's API called directly with a project API key.
     */
    provider: z.enum(['bedrock', 'litellm', 'openai']).default('bedrock'),

    /**
     * The id the provider is called with: a Bedrock model or inference-profile id, the
     * gateway's model alias for `litellm`, or OpenAI's model id (a dated snapshot, so an
     * upstream alias move is a registry change) for `openai`. The name predates the other
     * providers and is kept because stored candidates and the UI carry it.
     */
    bedrockModelId: z.string().min(1),

    /**
     * Region whose bedrock-runtime endpoint serves this model. For a geo inference
     * profile (a `us.` / `eu.` prefix) this is only the entry point — the request may
     * be served by any Region in the profile, which is why `residency` exists. For
     * `litellm` it names the gateway, which is the only hop this repo can vouch for. For
     * `openai` it is the API host the call goes to (`api.openai.com`, `eu.api.openai.com`),
     * and therefore where OpenAI processes the payload.
     */
    region: z.string().min(1),

    /**
     * Which Regions may actually process the payload. Recorded because a design sketch
     * is often pre-release product data and "where did this go" must be answerable from the
     * registry rather than from a support case.
     *
     * `global` stands for a global cross-Region profile, which may route to any supported
     * commercial Region and whose footprint cannot be listed
     * (https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html).
     * Only a `global.` id may declare it, so it is never a shortcut for an unmeasured list.
     */
    residency: z.array(z.string().min(1)).min(1),

    /**
     * Legacy models are not permitted. Kept as an explicit field rather than an
     * implicit assumption so that a model going legacy upstream becomes a one-line
     * change here and a hard load failure, not a silent quality regression.
     */
    lifecycle: z.enum(['active', 'legacy']),

    description: z.string().optional(),
    tags: z.array(z.string()).default([]),

    /** Canonical input names this model requires and accepts. */
    requiredInputs: z.array(z.string()).default([]),
    acceptsInputs: z.array(z.string()).default([]),

    params: z.array(paramSchema).default([]),

    /**
     * Whether the provider constrains the answer to a JSON Schema. Off for a model whose card
     * lists structured outputs as not supported; the schema then goes in the system prompt and
     * the parse is the only check.
     */
    structuredOutput: z.boolean().default(true),

    /**
     * Canonical name -> provider request field. The pipeline speaks canonical names
     * (`sketch`, `prompt`) and never the provider's spelling, so swapping models does
     * not ripple into pipeline code.
     */
    apiFieldMap: z.record(z.string(), z.string()).default({}),

    /** Indicative USD per call, for the pre-spend estimate in the UI. */
    costPerCall: z.number().nonnegative().optional(),

    isDefault: z.boolean().default(false),

    /** Compact prompting hint, surfaced to whatever builds the image-generation prompt. */
    promptGuide: z.string().optional(),

    notes: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.lifecycle !== 'active') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lifecycle'],
        message: `${entry.id}: legacy models are not permitted in this pipeline`,
      });
    }

    if (!entry.residency.includes(entry.region)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['residency'],
        message: `${entry.id}: residency must include the entry Region ${entry.region}`,
      });
    }

    if (entry.residency.includes(GLOBAL_RESIDENCY) && !isGlobalProfile(entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['residency'],
        message: `${entry.id}: residency "global" is only for a global. inference profile on Bedrock`,
      });
    }

    // No Bedrock image adapter exists: Bedrock has no multi-reference image model.
    if (entry.category === 'image-control' && entry.provider === 'bedrock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider'],
        message: `${entry.id}: image-control has no Bedrock adapter; use provider litellm or openai`,
      });
    }

    if (entry.provider === 'openai') {
      if (!OPENAI_API_HOST.test(entry.region)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['region'],
          message: `${entry.id}: an openai entry's region is its API host, api.openai.com or <prefix>.api.openai.com`,
        });
      }
      // The host is the whole footprint: anything else would claim a residency the call cannot have.
      if (entry.residency.length !== 1 || entry.residency[0] !== entry.region) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['residency'],
          message: `${entry.id}: an openai entry's residency is exactly its API host ${entry.region}`,
        });
      }
    }

    for (const input of entry.requiredInputs) {
      if (!entry.acceptsInputs.includes(input)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredInputs'],
          message: `${entry.id}: required input "${input}" is not in acceptsInputs`,
        });
      }
    }
  });

export type ModelEntry = z.infer<typeof modelEntrySchema>;

export type ModelProvider = ModelEntry['provider'];

/**
 * The `default` of a switch over `entry.provider`: a compile error when a switch misses a
 * provider, and a throw at run time rather than a fall-through to another transport.
 */
export function unsupportedProvider(id: string, provider: never): never {
  throw new Error(`${id}: unsupported provider ${String(provider)}`);
}

export const registrySchema = z.array(modelEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate model id: ${entry.id}`,
      });
    }
    seen.add(entry.id);
  }

  // Exactly one default per category, so `defaultFor()` is never ambiguous and a
  // category is never left without a model the pipeline can pick on its own.
  const byCategory = new Map<string, number>();
  for (const entry of entries.filter((e) => e.isDefault)) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
  }
  for (const [category, count] of byCategory) {
    if (count > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category ${category} has ${count} defaults; exactly one is allowed`,
      });
    }
  }
});
