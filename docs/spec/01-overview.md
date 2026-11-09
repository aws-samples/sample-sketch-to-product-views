# 01. Overview

## Goal

Turn a product design (one to five untagged images of one physical object: sketches or photos
of it and, optionally, a sample of its material; optional product details as plain text or
JSON) into **four photoreal studio views**: front, back, left
profile and right profile. The object can be anything with a front, a back and sides: furniture,
a lamp, a bottle, a device, a toy, footwear, a bag, a garment. There are no domain profiles: the
analyser names the object and its parts, and that drives the prompts and the critic. A
multimodal critic scores every view; rejected views are remade with
the critic's findings until they pass or an attempt budget runs out; a human then approves the
views or asks for changes in plain words. The run ends when a human approves; the approved views
are copied to a delivery location.

## Inputs and outputs

| In | Count | Required | Notes |
|---|---|---|---|
| Image | 1–5 | yes | Untagged. Any mix of technical drawings, illustrations of the object in use, sheets with several views side by side, detail insets, photos or renders of the product or a prototype, and photos of the actual material (fabric, leather, wood, metal, plastic, a paint finish). The analyser decides what each image is (`sketch`, `photo`, `material`, `ignored`) and which views it shows; at least one must be a sketch or a photo of the product. The first `material` is the material sample; further ones are references only. |
| Product details | 0–1 | no | Plain text or a JSON document of up to 64 KB, any keys (typically one exported spreadsheet row). Data only, never read by key, never defaulted from. Wire field `productMetadata`. |
| Design notes | 0–1 | no | Free text, up to 4000 characters, in any language, guiding the first generation. |
| Image model id | 0–1 | no | A registry id; the deployment default otherwise. |

| Out | Where |
|---|---|
| Four approved views, as the image model returned them | Delivery copies under the revision's delivery prefix ([02](02-data-contracts.md#storage-keys)) |
| The revision document | Analysis, specification with provenance, every candidate with its prompt, reference keys and verdict, the critic outcome, regenerations, the append-only stage-event log |

## Stages

Nine stages, in this order (stage id, number, label, group). The list is the single source of
stage identity: the backend emits events keyed by `id`, the UI renders from the same list.

| # | id | Label | Group | Does |
|---|---|---|---|---|
| 01 | `upload` | Upload product | intake | Browser uploads each file straight to object storage (recorded by the API at submit). |
| 02 | `submit` | Submit package | intake | API validates the request, creates the revision, starts one durable execution. |
| 03 | `validate` | Validate package | intake | Re-checks package rules and every stored file against the model limits. |
| 04 | `analyse` | Analyse images | intake | One multimodal LLM call reads every image and the product details into a structured analysis, deciding what each image is ([04](04-analysis.md)). |
| 05 | `complete_spec` | Complete specification | intake | Pure code: specification from the analysis, each field `supplied` or `observed`. Design notes routed to views here. |
| 06 | `generate_2d` | Generate 2D image | two_d | One image call per view: front, then back, then left and right in parallel ([05](05-prompt.md), [06](06-generation.md)). |
| 07 | `evaluate_2d` | Evaluate 2D image | two_d | One pairwise comparison per view and a verdict computed in code ([07](07-critic.md)). Retry loop. |
| 08 | `human_review` | Human review | review | Durable callback wait: approve, or regenerate with notes routed to views ([08](08-feedback-triage.md)). |
| 09 | `deliver` | Deliver approved views | review | Copies the approved views to the delivery prefix; status `approved`. |

Groups and their labels: `intake` "Product intake", `two_d` "2D generation & evaluation",
`review` "Review & delivery".

```text
validate ─► analyse ─► complete_spec ─► prompt ─► front ─► back ─► left ∥ right
                                          ▲                                │
                                          │   critic: one verdict per view ▼
                                          └── retry: remake failed views ◄─ evaluate_2d
                                              and the views made from them     │
                                                                               ▼
                                                     human review (approve / regenerate with notes)
                                                                               ▼
                                                                deliver the approved views
```

## Principles (normative)

1. **Inputs are never modified.** Uploaded images (the material sample among them) and generated views are stored and
   passed on byte for byte. A re-implementation MUST NOT downscale, crop or re-encode them
   without an explicit product decision. The only resized copy is the one sent to the critic's
   model, never stored ([07](07-critic.md#image-preparation)).
2. **No defaulted specification fields.** Every field is either *supplied* (the metadata states
   it, as read by the analyser) or *observed* (in the images), or it is absent and shown as
   unspecified. There are no per-product defaults.
3. **The analysis is the only source of the specification.** No code reads the metadata by key;
   column names may be anything. The analysis also decides what each image is; no code reads
   an upload role. When analysis fails, or no image is a sketch or a photo of the product, the
   run fails.
4. **The prompt is code.** An LLM fills the structured analysis; a deterministic template writes
   every image prompt. Same specification and options, same prompt, byte for byte.
5. **The verdict is code.** The critic's model answers `same`, `different` or `cant_tell` per
   aspect and part; code computes pass, warn or fail.
6. **Retries are targeted.** Only failed views and the views derived from them are remade, each
   told what was wrong.
7. **The pipeline never auto-accepts.** A human approves every delivery. When the budget is spent,
   the best attempt goes to review marked `approved: false`.
8. **Checkpoints hold decisions, not payloads.** Durable step results are ids, keys, verdicts and
   text. Image bytes live only in object storage and are passed by key.
9. **Text in inputs is data.** Metadata, file names, notes and reviewer comments are fenced or
   JSON-quoted in every model call and the model is told to ignore instructions in them.
10. **Every stage boundary has a schema**, validated at trust boundaries (API request, durable
    payload, callback result, model answers).

## Source precedence

| What | Decided by | Notes |
|---|---|---|
| What each image is | The analyser | No upload role; an older client's `swatch` tag is a hint only. |
| Shape and construction: silhouette, proportions between parts, every part and how it joins the rest, openings, closures, seams, one-sided elements, placed artwork | The sketch: every image read as `sketch` or `photo`, together | Never the metadata. |
| Main-surface colour, material, finish, pattern | The material sample (the first image read as `material`), when present | Wins over a written colour or material. |
| Colour without a sample | Metadata colour, else colours observed in coloured images | A sketch is often drawn in an arbitrary colour, so the critic never reads colour from the sketch. |
| Material without a sample | Metadata material, else visible surface cues | Never a guess at what is underneath. |
| Dimensions | Metadata only | A size cannot be measured on a drawing. |
| Product type | Metadata, else observed | What the object is, in the designer's words. |
| Open choices (which colour goes where, which drawn object is the product) | The analyser's `assumptions`, stated as facts and followed by the image model | |
| Views 2–4 | The front render (and the back render for profiles); the sketch again only when it draws that view | |
| Changes at review | The reviewer's requests | They overrule every input. |

## Non-goals

3D generation, cropping or retouching delivered views, per-revision cost tracking, choosing an
alternate image per call (one image per call), multi-reviewer approval workflows.
