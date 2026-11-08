# 02. Data contracts

Language-neutral shapes. `?` marks an optional field; absent and `undefined` are the same and are
never serialised. Types: `string`, `int` (integer), `number`, `bool`, `T[]`, `{…}`. Timestamps are
ISO 8601 UTC strings. Reference implementation: `contracts/src/`.

## Enumerations

| Name | Values |
|---|---|
| `InputRole` | `image`, `swatch`. Optional on the wire and never a decision: new clients send none; `swatch` is what an older client or a stored run sent for a material sample, passed to the analyser as a hint |
| `ImageKind` | `sketch`, `photo`, `material`, `ignored` (labels "Sketch", "Photo", "Material sample", "Not used"): what the analyser read an image as |
| `StageId` | `upload`, `submit`, `validate`, `analyse`, `complete_spec`, `generate_2d`, `evaluate_2d`, `human_review`, `deliver` |
| `StageStatus` | `pending`, `running`, `passed`, `failed`, `awaiting_review`, `skipped` |
| `RevisionStatus` | `running`, `awaiting_review`, `approved`, `failed`, `cancelled` |
| `CandidateView` | `front`, `back`, `left`, `right` (in this order everywhere) |
| `DrawnView` | `front`, `back`, `side` (what a sketch draws; a drawn `side` stands for both profiles) |
| `Source` (analysis) | `metadata`, `image`, `none` |
| `Provenance` (spec) | `supplied`, `observed` |
| `Verdict` | `pass`, `warn`, `fail` |

## Input package

`InputFile`: `{ role?: InputRole; filename: string; url: string; key?: string ≤1024 }`. `url` is a
display URL re-minted on every read; `key` is the storage identity the pipeline reads bytes by.

Package rules (one shared function used by the UI, the API and the `validate` stage; returns all
errors at once, never throws). Roles are not counted: what each image is, the analyser decides.

| Rule | Error text |
|---|---|
| ≥ 1 image | `At least one image is required.` |
| ≤ 5 images (`MAX_IMAGES`) | `At most 5 images are allowed.` |

The function also returns `warnings: string[]`, always empty today. The submit schema caps
`inputs` at `MAX_IMAGES` entries.

Per-file limits checked by `validate` on the stored bytes (the intersection of every model the
file is sent to; Converse allows at most 3.75 MB and 8000 × 8000 px per image,
[Message](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html)):

| Limit | Value |
|---|---|
| Formats (decoded, not declared) | jpeg, png, webp. gif is refused. |
| Size | ≤ 3,750,000 bytes (the decimal reading of "3.75 MB", the stricter one) |
| Dimensions | ≤ 8000 px per side; no minimum side, no aspect-ratio rule |

The upload path enforces the same 3,750,000-byte limit (presign and confirm) and accepts
`image/jpeg`, `image/png`, `image/webp`; format and dimensions are checked again at `validate`.

## Product details

Shown to users as "Product details (optional)"; the wire and storage field keeps the name
`productMetadata` for compatibility. Data only: sent to the analyser as given (after
[sanitisation](#free-text-sanitisation)), never read by key, never defaulted from.

`ProductMetadata`: `{ format: "text" | "json"; text: string (1 … 65,536 chars) }`. `json` when
the text parses as a JSON object or array: `text` is then the parsed document re-serialised with
two-space indentation, so what the analyser reads is stable. Anything else (plain words, a JSON
scalar, broken JSON) is `text`, sanitised. A stored `{ format: "json" }` value still parses.

Validators (shared by UI and API) return `{ ok: true, metadata }` or
`{ ok: false, error: { code, message } }`:

| Function | Checks, in order |
|---|---|
| file (UI only) | name ends `.txt` or `.json` (case-insensitive) or type is `text/plain` or `application/json`, else `unsupported_file` `"{name} is not a .txt or .json file."`; size ≤ 64 KB (65,536 bytes), else `too_large` `"{name} is larger than 64 KB; one product's details are expected."`; then the text check |
| text | sanitise (`sanitizeProductDetails`, below); UTF-8 byte length ≤ 65,536, else `too_large` `"The product details are larger than 64 KB; one product is expected."`; blank, else `empty` `"The product details are empty."`; when it parses as JSON and the value is empty, `empty` `"The product details have no data in them."`; an object or array → `json`, pretty-printed; otherwise `text`, trimmed |
| value (API) | shape is `{format:"text"\|"json", text:string}`, else `invalid` `"productMetadata must be { format: \"text\" \| \"json\", text: string }."`; then the text check on `text`, which recomputes `format` |

"Empty" (for JSON) means: `null`, a blank string, or an array/object whose every member is empty
(recursively). Any keys, nesting and arrays are accepted.

## Free-text sanitisation

Every string a user types or names (product ID, file names, product details, design notes,
review notes) passes one pure, idempotent function, `sanitizeText(text, { multiline })`
(`contracts/src/sanitize.ts`), in the web form (on blur, with a
`"{n} hidden or control character(s) removed."` hint), the CLI, the API (before the request
schema, so the length limits apply to the cleaned text) and the pipeline payload parser. In order:

1. Line breaks (CRLF, CR, U+0085, U+2028, U+2029) become `\n`; single-line fields turn `\n` and
   `\t` into a space.
2. Removed (and counted): C0 controls except `\t` and `\n`, DEL, C1 controls; every format
   character (category Cf: zero-width U+200B–U+200F, U+2060–U+2064, U+FEFF, bidi embeddings,
   overrides and isolates U+202A–U+202E, U+2066–U+2069, the soft hyphen, tag characters
   U+E0000–U+E007F); lone surrogates; the Hangul fillers U+115F, U+1160, U+3164, U+FFA0; the
   variation selectors U+FE00–U+FE0D and U+E0100–U+E01EF (VS15/VS16 kept for emoji).
3. Unicode NFKC.
4. A run of spaces and tabs becomes one tab if it held one, else one space; multiline: each line
   trimmed, at most one blank line in a row.
5. Trim.

Emoji and ordinary non-ASCII text are kept; an emoji sequence joined by U+200D falls apart into
its emoji, and NFKC turns compatibility forms into plain ones (`ﬁ` → `fi`, `²` → `2`).
`sanitizeProductDetails` keeps JSON structure: an object or array (parsed as given, or once
cleaned when hidden characters sat between tokens) has every key (single-line) and string value
(multiline) sanitised, then is re-serialised with two-space indentation; anything else is
multiline text. Sanitising removes hiding characters; it does not judge meaning (the guardrail
does, [03](03-orchestration.md#guardrail-screening)).

## Analysis (output of `analyse`)

```text
ProductField = { value: string; source: Source }
ImageReading = {
  image: int                               // 1-based, the upload order
  kind: ImageKind                          // what the image is
  views: DrawnView[]                       // what a sketch or photo shows; empty for material, ignored
  description: string                      // what the image shows, in a few words
}
Analysis = {
  product: { type, colour, material, dimensions : ProductField }   // type: what the object is
  images?: ImageReading[]                  // one per upload, in order; absent on runs analysed before
  views: DrawnView[]                       // every view the sketches and photos show, each once
  parts: { name: string; description: string; location: string }[]   // the object's main parts
  details: { description: string; location: string; view: DrawnView }[]
  ignored: string[]                        // marks that are not the product: notes, codes, figures
  observedColours: string[]                // from coloured images only
  materialCues: string[]                   // visible surface only, never what is underneath
  assumptions: string[]                    // decisions where the inputs left something open
}
```

The JSON Schema sent to the model and the post-processing (`checkAnalysis`) are in
[04](04-analysis.md#output-schema). The model returns `images` and no `views`; `checkAnalysis`
derives `views`. The checked analysis is stored on the revision as `analysis`.

### Which image plays which part

`planImages(inputs, kinds)` (pure, `contracts/src/images.ts`), with `kinds` the spec's
`imageKinds` (input order):

| Part | Images |
|---|---|
| Design references (`design`), named by kind in the image prompt ([05](05-prompt.md#sketches-photos-or-both)) | every `sketch` and `photo`, in upload order; `designKinds` holds which is which |
| Material sample (`material`) | the first `material` |
| Further materials (`extraMaterials`) | every later `material`: sent after the design references, as references only, with a run warning |
| The critic's sketch (`criticReference`) | the first `sketch`, else the first `photo` |
| Not used | every `ignored`, with a run warning |

Without `kinds` (a run analysed before images were classified), the roles decide: `swatch` is the
material sample and every other input a sketch.

## Specification (output of `complete_spec`)

```text
SpecField = { value: string /* normalised */; raw?: string /* only when normalisation changed it */; provenance: Provenance }
ProductSpec = {
  model: string                           // the product id
  productType?, materialDescription?, colorDescription?, dimensions? : SpecField
  views?: DrawnView[]                     // front, back, side order
  parts?: Analysis.parts                  // present only when non-empty
  details?: Analysis.details              // present only when non-empty
  ignored?: string[]                      // present only when non-empty
  assumptions?: string[]                  // present only when non-empty
  imageKinds?: ImageKind[]                // Analysis.images kinds, input order; absent on runs analysed before
}
```

Absent keys are dropped, never stored as `undefined`. The spec fields list, in order:
`productType`, `materialDescription`, `colorDescription`, `dimensions` (`SPEC_FIELDS`). There is
no category-specific field: a family, a fit or a composition in the metadata reaches the spec only
through the type or the material the analyser reads.

### Completion rule (pure, deterministic)

`supplied(f)` = the analysis field has source `metadata`; `observed(f)` = source `image`.

| Spec field | Value |
|---|---|
| `productType` | supplied(`type`) else observed(`type`) |
| `colorDescription` | supplied(`colour`); else, only when there is **no material sample**, `observedColours` joined |
| `materialDescription` | supplied(`material`); else, only when there is **no material sample**, `materialCues` joined |
| `dimensions` | supplied(`dimensions`) only: a size cannot be measured on a drawing |
| `views` | the analysis views filtered in the order `front, back, side` |
| `parts`, `details`, `ignored`, `assumptions` | copied when non-empty |
| `imageKinds` | each image's `kind`, when the analysis has `images` |

"Material sample" means `planImages(inputs, kinds).material` is set.

"Joined": trim, drop empties; one item as is; otherwise `"a, b and c"` (comma-separated, last
pair joined by ` and `). A joined value has provenance `observed`.

Every value passes through **normalisation**: trim, collapse whitespace, lower-case. Words are
never translated or expanded in code: the analyser reads the product details in their own
language. Idempotent. `raw` keeps the analyser's text when the normalised value differs. A
business with fixed abbreviations may map whole words there; never translate a token you are
unsure of.

### Run warning

`warning` (string, or absent when empty) is the space-joined concatenation of:

1. Image sentences, from `imageKinds` (`list` = `image n`, or `images a, b and c`):
   - further materials: `Image {first material} is the material sample; {list} is another material sample, sent as a reference only.` (plural: `… {list} are other material samples, sent as references only.`)
   - ignored images: `{List} does not show the product and is not used.` (plural: `… do not show the product and are not used.`)
2. A views sentence, unless both front and back are drawn:
   - no view: `No front, back or side view is available; all three will be assumed.`
   - otherwise: `Only the {shown views joined by " and "} view{s are|is} available; {missing as "the x", joined "a, b and c"} will be assumed.`
     Example: `Only the front view is available; the back and the side will be assumed.`
   (A missing side alone, with front and back drawn, gives no sentence.)
3. `Assumed: {assumption}` for each assumption.
4. `No product type found.` when `productType` is absent.
5. `No colour found.` / `No material found.` when the field is absent **and there is no material
   sample**.

Missing dimensions give no sentence: they are optional, and the sketch's proportions stand
without them.

## Critic aspects

`ASPECTS` (`contracts/src/attributes.ts`), object-neutral. Each aspect has a label (its prompt
wording), sources (`spec` a supplied fact, `sketch`, `swatch` the material sample, `convention`),
a weight (`must` 3, `should` 2, `nice` 1) and whether it is a hard fact (a confirmed difference
fails the view):

| Aspect | Label | Sources | Weight | Hard |
|---|---|---|---|---|
| `object_type` | what the object is | sketch, spec | must | yes |
| `shape` | the overall shape and silhouette | sketch | must | no |
| `proportions` | the relative size of the main parts | sketch | should | no |
| `parts` | each part or detail the sketch draws (one answer per part) | sketch | should | no |
| `color` | the dominant colour | spec, swatch | must | yes |
| `material` | the material and its finish | spec, swatch | should | no |
| `pattern` | patterns, graphics and text on the surface | sketch, swatch | should | no |
| `presentation` | a usable studio product image | convention | must | yes |

`sketchFidelity` scores the aspects with `sketch` among their sources, `specAdherence` those with
`spec` or `swatch` ([07](07-critic.md#verdict-judge-pure)).

`AttributeResult`: `{ attribute; expected: string; observed: string; outcome: match|close|mismatch|skipped; confidence: 0…1; reason?: string }`.
`attribute` is an aspect name or `part: {part}`; `expected` and `observed` are the critic's short
descriptions of the reference and of the view. `close` appears only on evaluations stored before
the pairwise critic.

Feedback triage offers the aspect names minus `presentation` as the names a request may change
([08](08-feedback-triage.md)); `Regeneration.attributes` holds those names.

## Evaluation and candidate

```text
ModelUse = { id: string /* registry id */; name: string; bedrockModelId: string /* provider model id */; region: string }
Evaluation = {
  verdict: Verdict
  scores: { sketchFidelity, specAdherence, imageQuality : number 0…1 }
  issues: string[]
  reviewer: string            // "judge"
  model?: ModelUse            // the critic model; optional so older records parse
  attributes?: AttributeResult[]
  confirmation?: { failedOn: string[]; confirmed: string[] }   // when a second call was made
}
Candidate = {
  id: string (UUID); url: string (empty when stored, minted on read); key?: string ≤1024
  modelId: string; model?: ModelUse
  attempt: int ≥1; view?: CandidateView (absent reads as front)
  createdAt: string; prompt?: string
  referenceKeys?: string[]    // keys of the images sent, in call order: design references, further materials, sample, renders
  evaluation?: Evaluation
  estimatedCostUsd?: number   // registry costPerCall, when the entry declares one
  latencyMs?: number
}
ViewMap = { front: string; back?, left?, right? : string }   // ids or keys, ≤1024 each
ViewUrls = same shape, URLs
```

## Review, regeneration, guidance

```text
ReviewDecision = { decision: "approve" | "regenerate"; candidateId?: string; notes?: string ≤4000 }
    // refine: regenerate requires notes with non-blank text ("regenerate needs a description of what to change")
ViewRequest   = { view: CandidateView; request: string (non-empty) }
Regeneration  = { round: int ≥1; notes: string; views: ViewRequest[]; attributes?: string[]; reviewedBy?: string }
Guidance      = Regeneration without round      // the design notes at submit
MAX_REGENERATIONS = 3
CriticOutcome = { approved: bool; attempt: int; attempts: int; issues: string[] }   // after a scored loop
              | { evaluated: false; attempt: int }                                  // after a regeneration
```

Pure helpers (normative):

- `viewsToRemake(asked)`: front asked → all four; back asked → back, left, right; a profile
  asked → itself. Output in view order.
- `requestsByView(rounds)`: for each view, every request it was given across the rounds, oldest
  first (guidance counts as the first round).
- `changedAttributes(rounds)`: every aspect changed across the rounds, de-duplicated, first
  appearance order.

## Stage events and detail

```text
StageDetail = { input?: any; output?: any; facts?: { [k]: string|number|bool }; truncated?: bool }
StageEvent  = { seq: int ≥0; revisionId; stage: StageId; status: StageStatus; at: string;
                message?: string; attempt?: int ≥1; view?: CandidateView; stubbed?: bool; detail?: StageDetail }
StageRun    = { status; attempt: int ≥0; message?; startedAt?; endedAt?; stubbed? }
```

- The event log is append-only; `seq` is minted atomically by the store (never by the caller).
- `stages[stageId]` is a projection **rebuilt from each transition**, never merged: `status`,
  `attempt` (0 when none), `message`, `startedAt` only on `running`, `endedAt` otherwise.
- `detail` is on events only, never on the projection. `attempt` on an event is the generation
  attempt; an SDK step retry is shown in the message as ` (retry N)`, never in `attempt`.

**Detail budget.** `captureDetail({input, output, facts})`: each of `input` and `output` is
JSON round-tripped; if its JSON exceeds 4096 characters (`DETAIL_BUDGET_BYTES`) it is replaced by
`{ omitted: "<shape>", bytes: <length> }` (shape: `array of N`, `object with keys a, b`, or the
type name) and `truncated: true` is set. A value JSON cannot represent counts as absent. `facts`
drops undefined entries; an empty facts object is omitted. Details never hold image bytes or
presigned URLs.

## Revision document (`PipelineState`)

The one document the UI polls.

| Field | Type | Written by |
|---|---|---|
| `revisionId` | UUID | create |
| `productId` | string | create |
| `revision` | int, always `1` (display only; nothing keys off it) | create |
| `status` | RevisionStatus | create `running`; gate `awaiting_review`/`running`; deliver `approved`; failure `failed` |
| `createdAt`, `updatedAt` | string | create; every write bumps `updatedAt` |
| `owner?` | JWT `sub` of the submitter, from verified claims only | create |
| `modelId` | image model registry id | create |
| `attemptBudget` | int ≥1 | create (`settings.attemptBudget`, else `ATTEMPT_BUDGET`, default 2) |
| `settings?` | GenerationSettings | create; only the values a run changed |
| `attempt` | int ≥0 | select steps |
| `inputs` | InputFile[] | create |
| `productMetadata?` | ProductMetadata, as validated | create |
| `analysis?` | Analysis | analyse |
| `spec?`, `warning?` | ProductSpec, string | complete_spec |
| `stages` | `{StageId → StageRun}`, every stage `pending`/0 at create | emit |
| `candidates` | Candidate[] | generation steps |
| `selectedCandidateId?`, `selectedViews?`, `criticOutcome?` | id of the selected front, ViewMap of ids, CriticOutcome | select steps |
| `regenerations?` | Regeneration[] | triage |
| `guidance?` | Guidance | design-notes routing |
| `failureReason?` | string | failure marking |
| `deliveryKey?`, `deliveryKeys?` | key of the front, ViewMap of keys | deliver |
| `deliveryUrl?`, `deliveryUrls?` | minted on read from the keys | read |
| `events` | StageEvent[] by `seq` | emit |

Not part of the document and never sent to a browser: the review callback id.

## Requests and payloads

| Shape | Fields |
|---|---|
| `SubmitRequest` (every text field sanitised first) | `productId` 1–64 chars; `inputs` InputFile[1…5], untagged; `productMetadata?` (product details); `modelId?` ≤128; `notes?` trimmed, 1–4000; `settings?` GenerationSettings |
| `GenerationSettings` | strict object, all optional: `size`, `quality`, `complexity` (strings 1–32, each checked against the chosen model's registry options), `attemptBudget` int 1–4 (`MAX_ATTEMPT_BUDGET`) |
| `PipelineInput` (durable payload) | `revisionId`, `productId`, `inputs` (≥1), `productMetadata?`, `modelId` (resolved), `submittedBy?`, `createdAt` (the stored value), `requests?: { notes 1–4000 trimmed; reviewedBy? }`, `settings?` GenerationSettings |
| `PresignRequest` | `productId` 1–64; `filename` 1–255; `contentType` 1–128; `sizeBytes` int > 0; `role?` InputRole, accepted and ignored |
| `PresignResponse` | `uploadUrl`, `key`, `cdnUrl` (a presigned GET), `contentType` |
| Callback result | `ReviewDecision` plus `reviewedBy` (verified display name) and `reviewedAt` |

## Storage keys

| Object | Key |
|---|---|
| Upload | `product/{productId}/uploads/{uuid}/{safeFilename}` |
| Candidate | `product/{productId}/{revSegment}/candidates/{candidateId}.{png\|jpg\|webp}` (extension from the image's sniffed type) |
| Delivery | `product/{productId}/{revSegment}/delivery/{productId}-approved.{ext}` (front), `…/{productId}-approved-{view}.{ext}` (others) |

- `revSegment` = `{stamp}-{revisionId}`; `stamp` = the stored `createdAt` as
  `YYYYMMDDTHHMMSSZ` (dashes and colons removed, milliseconds dropped), or `undated` when
  unparseable. Derived from the stored value, never the clock, so replays write the same prefix,
  and two revisions of one product never share a prefix.
- `safeFilename`: last path segment; every character outside `[A-Za-z0-9._-]` becomes `_`;
  leading dots stripped; at most 128 characters; `file` when empty.
- Content type is always sniffed from magic bytes: `FF D8 FF` jpeg, `89 50 4E 47` png,
  `RIFF....WEBP` webp. A declared type is a client assertion.

## Revision store layout (key-value table)

| pk | sk | Item |
|---|---|---|
| `REV#{revisionId}` | `META` | the revision minus `events`, plus `seq` (event counter) and `reviewCallbackId` |
| `REV#{revisionId}` | `EVENT#{seq zero-padded to 6}` | `{ event: StageEvent }` |

Reading a revision is one strongly consistent query on the partition, following continuation
keys. Writes: create is conditional on the item not existing; patch is a shallow `SET` of the
given fields plus `updatedAt`, conditional on existence; emit is an atomic `ADD seq 1` plus `SET`
of `updatedAt` and `stages.{id}` in one update, then a put of the event item. ETag:
`W/"{sha1(updatedAt:eventCount:status)}"`.
