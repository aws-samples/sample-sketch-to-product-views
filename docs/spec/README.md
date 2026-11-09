# Specification: sketch to four photoreal product views

This is the implementation-independent specification of the sample. It describes every
behaviour, contract, prompt, rule and number needed to rebuild it, so that the specification
alone (without the code) is enough for a faithful re-implementation in any language. The code in
this repository is the **reference implementation**; file paths are given only as pointers into
it. Where this specification and the code disagree, the code is authoritative and the
specification is the bug.

## Reading order

| # | Document | Covers |
|---|---|---|
| 01 | [Overview](01-overview.md) | Goal, inputs and outputs, the nine stages, principles, source precedence |
| 02 | [Data contracts](02-data-contracts.md) | Every shape exchanged or stored, validators, spec completion, attribute vocabulary, storage keys, store layout |
| 03 | [Orchestration](03-orchestration.md) | Durable-function rules, step names, retry classification, the generate-and-evaluate loop, regeneration, review gate, delivery |
| 04 | [Analysis](04-analysis.md) | Analyser prompt (verbatim), request, schema, checks, failures |
| 05 | [Prompt](05-prompt.md) | Image prompt template (verbatim), inputs per view, golden outputs |
| 06 | [Generation](06-generation.md) | Image API call, settings, error classification, keys |
| 07 | [Critic](07-critic.md) | Pairwise comparison (verbatim prompts), confirmation and verdict |
| 08 | [Feedback triage](08-feedback-triage.md) | Routing design notes and reviewer comments to views (verbatim prompt) |
| 09 | [Model registry](09-model-registry.md) | Entry schema, providers, shipped entries, adding a model |
| 10 | [API and UI](10-api-and-ui.md) | Routes, auth, uploads, the web screens |
| 11 | [Infrastructure](11-infrastructure.md) | AWS resources and why, IAM, configuration, Region and inference profiles |
| 12 | [Acceptance](12-acceptance.md) | Behaviours to pass, by stage; free smoke test |
| 13 | [Decisions](13-decisions.md) | Decisions with rationale and rejected alternatives; open questions |

Read 01 to 03 first; 04 to 08 are the model-facing know-how; 09 to 11 are the platform.

## Using this with an AI coding assistant

1. Give the assistant this directory only, and state the target language and IaC tool.
2. Have it implement in dependency order, one file (or module) at a time, each with its tests
   from [12](12-acceptance.md): contracts (02) → registry (09) → prompt and view planning (05) →
   analyser (04), triage (08), image adapter (06), critic (07) → orchestration (03) → API (10) →
   infrastructure (11) → UI (10).
3. Copy every block marked **verbatim** exactly: the prompts are the core know-how and small
   wording changes move results. Check the prompt builder against the golden outputs in
   [05](05-prompt.md#golden-outputs) byte for byte.
4. Run the free smoke test ([12](12-acceptance.md#free-smoke-test)) before any paid image call,
   and show the exact prompts and the number of image calls before a paid run.
5. Verify external limits (models, sizes, quotas, Regions) against current provider
   documentation before changing a number; the values here were verified when written.

## Conformance checklist

- [ ] Nine stages with these ids, labels and groups; the UI renders from the same list.
- [ ] Package rules: 1–5 untagged images; stored files ≤ 3.75 MB, ≤ 8000 px, jpeg/png/webp.
- [ ] Product details plain text or JSON, never read by key; validated as a container only; sent verbatim, fenced, as data.
- [ ] Analyser prompt, schema and checks as in 04; it decides what each image is; analysis failure, or no sketch or photo of the product, fails the run.
- [ ] Generation and the critic pick images with `planImages` (02), never by upload role.
- [ ] Spec fields only `supplied` or `observed`; no defaults; normalised value plus `raw`.
- [ ] Prompt builder reproduces the golden outputs; no LLM writes image prompts.
- [ ] Front from the design references + material sample; back from the front render; profiles from both renders
      and run concurrently; sketch and sample again only when the sketch draws the view.
- [ ] Inputs and generated views stored byte for byte; only the critic's transient copy is resized.
- [ ] Critic verdict computed in code from one pairwise comparison per view, object-neutral aspects,
      hard facts confirmed by a second call.
- [ ] Retry loop: failed front → all four; failed back → back and profiles; failed profile → itself;
      corrections = the view's issues (≤ 4); budget spent → best attempt to review, `approved: false`.
- [ ] Unique, stable step names per stage, view, attempt and review round; non-determinism only in
      steps; checkpoints hold keys, never bytes; deterministic backoff, transient vs terminal as in 03.
- [ ] Review gate on a durable callback; callback id stored server-side only; decision validated in
      the API and the pipeline; regenerations routed by triage, cascaded by code, one unscored
      attempt, at most 3.
- [ ] Delivery copies every view under a per-revision prefix.
- [ ] API: 7 routes, JWT on all, owner authorization, presign → PUT → confirm with magic-byte check,
      URLs minted on read, ETag polling.
- [ ] Durable execution enabled at creation; invoked via a qualified alias with the revision id as
      execution name; least-privilege IAM; KMS on data and logs; JSON logs at INFO.
- [ ] Every free-text input sanitised (02) in the UI, the API before validation, and the pipeline;
      with a guardrail, every user-written string screened before any model reads it, only user text
      in `guardContent`, a block terminal and naming the policy, a blocked review note a 400 (03).
- [ ] Every acceptance behaviour in 12 passes.

## Glossary

| Term | Meaning |
|---|---|
| Revision | One submitted package and its run: one revision = one durable execution. |
| Image | An uploaded file, untagged. The analyser reads it as a `sketch` (flat or on a figure, coloured or not), a `photo` (of the product or a prototype), a `material` or `ignored`. |
| Design references | Every image read as a sketch or a photo, together, in upload order. The image prompt calls them "the sketch" when all are sketches, "the photo(s) of the product" when all are photos, and names each when mixed ([05](05-prompt.md#sketches-photos-or-both)). |
| Material sample | The first image the analyser read as `material`: a photo of the actual material (fabric, leather, wood, metal, plastic, a paint finish). |
| Product details | Optional plain text or JSON of whatever the business knows about the product, in any shape (wire field `productMetadata`). |
| Design notes / guidance | Free text at submit, routed to views like a regeneration. |
| Analysis | The analyser's structured reading of the images and product details, including what each image is. |
| Specification (spec) | Product fields built from the analysis, each `supplied` (metadata) or `observed` (images). |
| View | `front`, `back`, `left`, `right`: one camera position, one call, one image. A *drawn* view (`front`, `back`, `side`) is what a sketch shows; a drawn side covers both profiles. |
| Render | A generated view used as a reference for the next ones (front render, back render). |
| Attempt | One pass making the views that need making; numbered across the run, including regenerations. |
| Candidate | One generated image with its view, attempt, prompt, reference keys and verdict. |
| Critic | One pairwise comparison of the view with the sketch by a vision model, and a verdict computed in code. |
| Corrections | The critic's issues on a rejected view, passed to that view's next prompt. |
| Requests | Per-view instructions routed from design notes or a reviewer's comment; they overrule the inputs. |
| Regeneration | A review round that remakes the requested views and their dependants, unscored. |
| Registry entry | One model's configuration (provider, model id, Region, residency, params). |
| Residency | Where a provider may process a call's payload. |
| Step | A checkpointed durable operation; its result is replayed, not re-executed. |
