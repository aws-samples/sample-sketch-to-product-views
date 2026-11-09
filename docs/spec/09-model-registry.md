# 09. Model registry

Every model call is resolved through a registry of entries authored as one YAML file per model,
validated at build time and compiled to JSON that ships with the functions (no YAML parser and
no parse failure at cold start). Deployment configuration names **registry ids**, never provider
model ids. Reference implementation: `shared/src/registry/` (`schema.ts`, `index.ts`,
`codegen.ts`, `models/*.yaml`).

## Entry schema

| Field | Type | Rule |
|---|---|---|
| `id` | string | unique across the registry |
| `name` | string | human name, recorded on runs |
| `category` | `image-control` \| `critic` \| `analyser` | `image-control` conditions generation on a sketch |
| `provider` | `bedrock` \| `litellm` \| `openai`, default `bedrock` | `image-control` may not be `bedrock` (no multi-reference image model) |
| `bedrockModelId` | string | the id the provider is called with: Bedrock model or inference-profile id, gateway alias, or OpenAI model id (prefer dated snapshots). Name kept for stored runs. |
| `region` | string | Bedrock: Region whose runtime endpoint is called. LiteLLM: the gateway host. OpenAI: the API host (`api.openai.com` or `<prefix>.api.openai.com`), which is where the payload is processed |
| `residency` | string[] ≥ 1 | Regions or hosts that may process the payload; must include `region`; `global` only for a Bedrock `global.` profile; an OpenAI entry's residency is exactly `[region]` |
| `lifecycle` | `active` \| `legacy` | `legacy` fails validation |
| `description`, `notes`, `promptGuide` | string? | informational (`promptGuide` is shown to whoever writes prompts) |
| `tags` | string[], default `[]` | |
| `requiredInputs`, `acceptsInputs` | string[], default `[]` | canonical input names; each required input must be accepted. `swatch` (the material sample, as the analyser picked it) in `acceptsInputs` decides whether an image model gets the material sample |
| `params` | Param[], default `[]` | see below |
| `structuredOutput` | bool, default `true` | false: the JSON Schema goes in the system prompt instead of being enforced |
| `apiFieldMap` | `{canonical → provider field}`, default `{}` | the pipeline speaks canonical names (`prompt`, `sketch`, `size`, …) |
| `costPerCall` | number ≥ 0? | indicative USD per call; omit when unknown rather than guess |
| `isDefault` | bool, default `false` | at most one default per category; resolution needs exactly one for each used category |

Param: `{ key; type: string|number|boolean|select; label?; description?; default?: string|number|bool; options?: {value, label}[]; min?; max?; step?; advanced: bool (default false) }`.

Validation errors name the YAML file and field.

## Resolution

| Function | Behaviour |
|---|---|
| `modelById(id)` | throws `unknown model: {id}. Known: …` |
| `findModel(id)` | returns nothing for an unknown id (the API turns it into a 400) |
| `defaultFor(category)` | the `isDefault` entry, else throws |
| `resolveModel(category, id?)` | `id` → that entry, else the default; throws `model {id} is {category}, not {wanted}` on a category mismatch |
| `deployedModel(category, envValue)` | blank or unset → default. Called at **cold start** for the analyser and the critic, so a wrong id fails the deployment, not a run |
| `numericParam(entry, key, fallback)` | the param's numeric default, else fallback |
| `selectParam(entry, key, override?)` | blank override → the param default; an override not among the options throws naming them |
| `modelUse(entry)` | `{id, name, bedrockModelId, region}`, recorded on candidates and evaluations at call time, so later registry changes never relabel past runs |

How each category's params are used: the analyser sends `max_tokens` and `temperature`
**only when declared** (some models reject `temperature`; the token field name differs between
providers); the critic always sends both, from the entry or the fallbacks 4096 and 0, raised to
the comparison's 3072-token floor and, for the confirmation call, at temperature 0.7
([07](07-critic.md#verdict-judge-pure)); image entries send every param default through `apiFieldMap`, overridden by
`size`/`quality` settings.

## Providers

| Provider | Auth | Endpoint | Used for |
|---|---|---|---|
| `bedrock` | the function's IAM role | `bedrock-runtime` in `region`, Converse | analyser, critic |
| `openai` | project API key (env or Secrets Manager) | `https://{region}` (`OPENAI_BASE_URL` overrides) | image, analyser |
| `litellm` | gateway virtual key (env or Secrets Manager) | `LITELLM_BASE_URL` | image, analyser; any OpenAI-compatible proxy |

## Shipped entries

Defaults are bold. Bedrock entries use **US geo inference profiles** entered from `us-east-1`,
residency `[us-east-1, us-east-2, us-west-2]` (read from the profile; re-read with
`aws bedrock get-inference-profile` before relying on it).

| id | Category | Provider | Model id | Notes |
|---|---|---|---|---|
| **`gpt-image-2.6-sunburst-openai`** | image-control | openai | `gpt-image-2.6-sunburst` | default image model; `api.openai.com`; adds a `complexity` param (`low`/`medium`/`high`, default `high`) |
| `gpt-image-2.6-flare-openai` | image-control | openai | `gpt-image-2.6-flare` | same params as 2.6 Sunburst |
| `gpt-image-sunburst-openai` | image-control | openai | `gpt-image-2.5-sunburst-2026-09-08` | |
| `gpt-image-flare-openai` | image-control | openai | `gpt-image-2.5-flare-2026-09-08` | |
| `gpt-image-sunburst` | image-control | litellm | `gpt-image-2.5-sunburst` | example gateway alias |
| `gpt-image-flare` | image-control | litellm | `gpt-image-2.5-flare` | example gateway alias |
| **`analyser-sonnet-bedrock`** | analyser | bedrock | `us.anthropic.claude-sonnet-5-5` | `structuredOutput: false` (the profile rejects `outputConfig`), `max_tokens` 4096 |
| `analyser-luna-bedrock` | analyser | bedrock | `us.openai.gpt-5.6-luna` | structured output; `max_tokens` 4096; no `temperature` (rejected); IAM also needs the account's `project/default` |
| `analyser-luna-openai` | analyser | openai | `gpt-5.6-luna` | no params |
| `analyser-luna-litellm` | analyser | litellm | `gpt-5.6-luna` | example gateway alias, no params |
| **`critic-sonnet`** | critic | bedrock | `us.anthropic.claude-sonnet-4-6` | structured output; `max_tokens` 4096 (256–4096; the comparison needs at least 3072), `temperature` 0; `costPerCall` 0.01 |
| `critic-nova-pro` | critic | bedrock | `us.amazon.nova-pro-v1:0` | `structuredOutput: false`; `max_tokens` 4096; a second model family for building ground truth; `costPerCall` 0.003 |

Every image entry shares: `requiredInputs [prompt, sketch]`, `acceptsInputs [prompt, sketch,
swatch]`, `apiFieldMap {prompt: prompt, sketch: image, size: size, quality: quality,
output_format: output_format}`, params `size` (select, default `2336x3504`; options `2336x3504`,
`1536x2304`, `1024x1536`, `1024x1024`, `1536x1024`), `quality` (select, default `max`; `low`,
`medium`, `high`, `xhigh`, `max`), `output_format` (select, default `png`; `png`, `jpeg`, `webp`,
advanced), no `costPerCall`. Analyser entries: `requiredInputs [images]`,
`acceptsInputs [images, product_metadata]`. Critic entries: `requiredInputs [sketch, candidate,
spec]`, `acceptsInputs [sketch, candidate, spec, swatch]`.

The LiteLLM entries are examples: the gateway host (`litellm.example.internal`) and aliases are
placeholders to replace with your gateway's model list. Where a gateway's provider processes the
payload is not knowable from the registry; residency lists only the gateway hop.

## Adding a model

1. Read the provider's documentation for the limits (input images, sizes, formats, structured
   output support, which parameters it rejects) and record the sources.
2. Write one YAML file: category, provider, provider model id, region, residency as measured,
   `lifecycle: active`, params with defaults the model accepts, `structuredOutput` per its card,
   `apiFieldMap` for form-based providers.
3. Build: validation fails on a legacy entry, a residency without the region, `global` on a
   non-global entry, a Bedrock image entry, a bad OpenAI host, a required input not accepted, a
   duplicate id or two defaults in a category.
4. Check access from the target account and Region (the reference repo has `npm run models:check`,
   which lists what the credentials can reach).
5. Select it per deployment (`image_model`, `analyser_model`, `evaluation_model`), or per run for
   the image model (`modelId` at submit). A model switch needs no code change.
