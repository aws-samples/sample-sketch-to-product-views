# 06. Image generation (stage `generate_2d`)

One call per view, one image per call, to an image model that takes **several reference images**
in one edit request. Reference implementation: `pipeline/src/stages/generate-2d.ts`,
`shared/src/generate/openai-image.ts`, `dispatch.ts`, `shared/src/openai/compatible.ts`.

## Why this API

The front needs the design references (the images the analyser read as sketches and photos) and the material sample in one call; the other views need the front
(and back) renders. Amazon Bedrock offers no image model that takes several reference images,
so the registry forbids `provider: bedrock` for image entries and the default image model is
reached through OpenAI's [image edit endpoint](https://developers.openai.com/api/reference/python/resources/images/methods/edit)
(up to 16 input images; png, webp, jpg; each under 50 MB), either directly or through any
OpenAI-compatible LiteLLM gateway.

## Per-view procedure

1. Plan the call ([05](05-prompt.md#which-images-each-call-gets-planviewcall)): image keys in
   call order and the prompt. The plan's `designKinds` goes to every call, so the prompt reads a
   sketch as a design drawing and a photo as the real product
   ([05](05-prompt.md#sketches-photos-or-both)). A non-front view without a front render key fails:
   `the {view} view needs the front render and none was given`. No `image` input fails:
   `no image available for generation`.
2. Read every image's bytes by key from object storage (never follow a URL).
3. Call the generator with: registry id, prompt, first image, the remaining images as
   `references`, and the attempt's settings (`size`, `quality`).
4. Store the returned bytes under a fresh candidate key (extension from the sniffed type).
5. Return a `Candidate` ([02](02-data-contracts.md#evaluation-and-candidate)): new UUID, `url: ""`,
   `key`, `modelId`, `model` (ModelUse), `attempt`, `createdAt`, `prompt`, `view`,
   `referenceKeys` (in call order), `estimatedCostUsd` when the entry has `costPerCall`,
   `latencyMs`. **No bytes.**

## Settings

`imageSettings(entry, overrides)`: for each of `size`, `quality` and `complexity` the entry
declares, the run's setting (`PipelineInput.settings`), else the deployment's (`IMAGE_SIZE`,
`IMAGE_QUALITY`; complexity has none), when set and non-blank, else the entry's param default. An override that is not
one of the param's `options` throws `{id} does not offer {key} "{value}"; options: a, b, c`
before any call is paid for. Resolved once per attempt, so the views of an attempt never differ.

Defaults of the shipped image entries: `2336x3504`, `max`, `output_format=png`. 2336×3504 is the
largest 2:3 portrait the custom-size rules allow (sides multiples of 16, ratio 1:3 to 3:1,
655,360 to 8,294,400 px, edge ≤ 3840); about 90 s per call. `1536x2304` at `high` is the cheaper
fallback for iteration. `input_fidelity` is not sent (OpenAI says to omit it for the 2.x image
models). The image model has no seed, so a view is reproducible only by its recorded inputs.

## Request (OpenAI-compatible)

`POST {base}/v1/images/edits`, `multipart/form-data`, `Authorization: Bearer {key}`, plus
`OpenAI-Organization` / `OpenAI-Project` headers when configured (direct OpenAI only).

| Part | Value |
|---|---|
| `model` | the entry's provider model id |
| registry params | every param with a default, under its `apiFieldMap` name; then caller values override, only for keys the map names; empty values skipped |
| `prompt` | the prompt |
| images | first image then references, each a file part typed from its magic bytes and named `sketch.{ext}`, `reference-1.{ext}`, … |

Image field name: `apiFieldMap.sketch` (default `image`). For direct OpenAI with more than one
image, the field is `image[]` (OpenAI rejects a repeated `image`); for a LiteLLM gateway it is
the repeated plain name (the gateway forwards `image[]` parts as strings). The base URL is
`https://{entry.region}` for direct OpenAI (the entry's region **is** the API host, so the
registry decides where the payload is processed; `OPENAI_BASE_URL` overrides it for tests and
proxies) and `LITELLM_BASE_URL` for the gateway. Trailing slashes are trimmed.

Timeout: 300 s per call (`IMAGE_CALL_TIMEOUT_MS`, overridable with a positive number in the
environment); a timeout is transient. No client-side retries (they would stack on the durable
step's three attempts).

Response: `{ data: [{ b64_json }] }` (at least one). Decode `data[0].b64_json`; the content type is
sniffed from the bytes. Any other body: `{id}: unrecognised response shape from {model id}`.

## Error classification

Error body shape `{ error: { message, type, code } }`; the reason is `message` (or the raw body),
clipped to 300 characters. `x-request-id` is quoted in messages when present. Keys never appear
in a message.

| Condition (checked in order) | Result | Retry |
|---|---|---|
| `code` in {`content_policy_violation`, `moderation_blocked`} or `type` = `image_generation_user_error`, any status | `ContentRefusedError` `generation refused by the provider: {id}: {code}: {message}[ (request {id})]` (analyser: `AnalysisInvalidError`) | terminal |
| status 401 or 403; or `code` in {`insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`}; or `type` = `insufficient_quota` | `ProviderAccessError` (carries no HTTP status for the retry policy) | terminal |
| anything else | `OpenAIError` / `LiteLLMError` with `$metadata.httpStatusCode = status`, message `{id}: {OpenAI\|gateway} answered {status}: {reason}[ (request {id})]` | by status: 408, 429, 5xx transient; other 4xx terminal |

Rationale: OpenAI documents that quota exhaustion is a 429 that retrying will not fix, and that
moderation blocks must not be retried automatically
([error codes](https://developers.openai.com/api/docs/guides/error-codes),
[image generation](https://developers.openai.com/api/docs/guides/image-generation)).

## Keys

A provider key comes from the environment variable when set (`OPENAI_API_KEY`,
`LITELLM_API_KEY`), else from the Secrets Manager secret named by `OPENAI_API_KEY_SECRET_ARN` /
`LITELLM_API_KEY_SECRET_ARN`: either the bare key or JSON `{"apiKey": "…"}`. Read once per
process and ARN; a failed read is forgotten so the next call retries. Neither set:
`{OpenAI|LiteLLM} key missing: set {VAR} or {SECRET_VAR}`. Keys are never logged; error text is
redacted (`Bearer …`, `sk-…`, inline `data:…;base64,…`).

## Dispatch

`resolveModel("image-control", id)` then by `provider`: `openai` → direct adapter, `litellm` →
gateway adapter, `bedrock` → throw `{id}: no Bedrock image adapter; Bedrock serves the analyser
and critic`. An adapter refuses an entry of the other provider. The switch is exhaustive: an
unknown provider throws rather than falling through.

## Timing and cost

Per attempt: front (~90 s), back (~90 s), then both profiles concurrently (~90–200 s; the
provider may queue concurrent calls). One function invocation must hold the longest step, so the
pipeline function timeout is the Lambda maximum, 900 s; an invocation cut short resumes from the
last checkpoint. The default budget makes at most 8 image calls before review, plus up to 4 per
regeneration. The 2.5 image models are priced per token with no published per-image price for
`max`, so the image entries carry no `costPerCall`.
