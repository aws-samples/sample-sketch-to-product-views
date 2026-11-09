# 12. Acceptance

Behaviours a re-implementation must pass, distilled from the reference test suites (each
package's `test/` directory). Run them with fakes for the durable context (one that runs each
step, asks the step's own retry strategy whether to rerun it, records step names, and serves
queued review decisions), the store (in-memory maps) and every model call. Operations are
asserted **by name**, never by index. The golden prompts in [05](05-prompt.md#golden-outputs) are
also acceptance checks.

## Contracts

| Given | When | Then |
|---|---|---|
| 1–5 images, untagged or with an older client's roles (two `swatch` included) | package rules | valid; roles are not counted |
| no image; 6 images | package rules | `At least one image is required.` / `At most 5 images are allowed.`; all errors at once |
| an input with no role | submit schema | accepted |
| a removed role (`front_sketch`, …) or a sixth file | submit schema | rejected |
| product details as JSON with unknown keys, nesting, arrays, a BOM | text validator | `json`; stored text is the re-serialised document |
| plain text, broken JSON, a JSON scalar (`42`, `"ivory"`) | text validator | `text`, sanitised |
| text with zero-width, bidi, tag or control characters, a soft hyphen, data-carrying variation selectors | `sanitizeText` | removed and counted; multiline keeps `\n` and `\t`; single-line turns them into a space |
| CRLF, CR, U+2028, runs of blanks, three blank lines; full-width letters, a ligature | `sanitizeText` | `\n`; one blank; one blank line; NFKC plain forms |
| emoji, `é`, `日本語` | `sanitizeText` | unchanged, nothing counted |
| any text, twice | `sanitizeText`, `sanitizeProductDetails` | identical (idempotent) |
| JSON details with hidden characters in keys, values, escapes or between tokens | `sanitizeProductDetails` | still `json`; same structure; keys and values clean; re-serialised |
| a submit or review body with hidden characters | sanitise body | each text field clean before the schema runs |
| blank text / `{}` / `[]` / `""` / `null` / > 64 KB / not a `.txt` or `.json` file / an unknown `format` | validators | `empty` / `empty` / `too_large` (before reading) / `unsupported_file` / `invalid` |
| a stored `{format: "json"}` value whose text is not JSON | value validator | accepted as `text` |
| analyser images out of order, a material with views, a view twice | `checkAnalysis` | sorted by number; material and ignored images show no view; `views` derived once from the sketches and photos |
| an image list missing or repeating an image | analyser | `AnalysisMalformedError`, retried |
| no image read as sketch or photo | analyser | `AnalysisInvalidError` naming what each image was read as; terminal, the run fails after one analyse step |
| kinds (material, photo, sketch, material, ignored) | `planImages` | design = photo, sketch; material = the first material; extra = the second; critic sketch = the sketch (else the first photo); no kinds → roles decide |
| an analysis with a view twice, dimensions from the images, blank values, padded strings, a part without a name, an empty ignored mark | `checkAnalysis` | one view, dimensions `none` (metadata dimensions kept), blanks `none`, trimmed, never cut, the nameless part and the empty mark dropped; metadata values kept even paraphrased |
| the analysis JSON Schema | inspect | only supported keywords; every object closed and fully required; the strict mirror rejects an extra field |
| an empty analysis | `completeSpec` | spec `{model}` only |
| metadata fields and image fields | `completeSpec` | metadata fields `supplied` and winning; others `observed`; dimensions only supplied and normalised; `parts`, `details` and `ignored` copied, absent when empty |
| a material sample (the analyser's) | `completeSpec` | observed colour and material dropped, supplied ones kept; `imageKinds` copied from the analysis |
| a second material, an ignored image | `warningFor` | `Image 2 is the material sample; image 3 is another material sample, sent as a reference only. Image 4 does not show the product and is not used.` |
| any analysis | `completeSpec` twice | identical spec; views in front, back, side order |
| a spec | `warningFor` | views sentence, `Assumed:` lines, then `No product type found.`, `No colour found.`, `No material found.` for the gaps; quiet about a missing side alone, about colour and material with a material sample, and about dimensions; undefined when empty |
| raw tokens | normalise | abbreviations expand, phrase before word, whole words only, unknown tokens lower-cased, idempotent |
| a snapshot over 4096 chars / undefined facts / unserialisable value | `captureDetail` | replaced by its shape and `truncated`; facts dropped (object omitted if empty); treated as absent |
| asked views | `viewsToRemake` | front → all four; back → back and both profiles; a profile → itself |
| regenerations | `requestsByView`, `changedAttributes` | oldest first per view; aspects once each |
| `regenerate` without notes | decision schema | rejected; `approve` without notes accepted |
| owner / other subject / empty owner | authz | owner reads and reviews; other neither (404: not found under their key); empty owner matches nobody |
| the aspects | inspect | aligned with the CSV on names, sources, weights and hard facts; colour never compared with the sketch; only object type, colour and presentation are hard; `side` refused as a candidate view |

## Analysis

| Given | When | Then |
|---|---|---|
| two images and product details | request | every image in upload order, the material sample among them, each after `Image N (file name: "…"):`; file names JSON-quoted; details verbatim in a fenced block labelled data, `json` or `text` |
| plain-text details containing a backtick fence | request | a longer fence, so the text cannot close it |
| no details / an older client's `swatch` upload | request | the "No product details were supplied" sentence / `, uploaded as a material sample` in that image's label |
| the system prompt | inspect | metadata, file names and text in the images are data; `ignored` asked for; no garment, fabric, sleeve or composition wording |
| a chat entry with no declared params | request | strict `json_schema` response format; no `temperature`, no token limit |
| a Bedrock entry | request | Converse in the entry's Region, same prompt, images and metadata; `outputConfig` json_schema as a string, or the schema in the prompt when `structuredOutput: false`; `max_tokens` (4096 on the shipped entries); no `temperature` unless declared |
| an off-schema answer; a view outside front/back/side; truncation | parse | `AnalysisMalformedError` naming the missing fields |
| refusal, content filter, moderation block (any status) | call | `AnalysisInvalidError` (terminal) |
| a Bedrock entry, a guardrail configured | request | `guardrailConfig` (id, version, trace `disabled`); only the quoted file names and the details text are `guardContent`; system prompt and images unwrapped; `outputConfig` unchanged |
| no guardrail | request | no `guardrailConfig`, no `guardContent` |
| Bedrock `guardrail_intervened` | call | `GuardrailBlockedError` `Analyser call: blocked by the content guardrail.` (terminal) |
| 429 rate limit, 5xx, throttle | call | error carrying its status / unchanged SDK error (transient) |
| quota 429, 401, 403 | call | `ProviderAccessError` (terminal) |

## Feedback triage

| Given | When | Then |
|---|---|---|
| a comment and a spec | request | one text-only structured call; `Product: {type}.`, the parts and details drawn, `Aspects: object_type, shape, proportions, parts, color, material, pattern.`, the comment as a JSON string; no `presentation` |
| an aspect outside that list in the answer | parse | dropped |
| two requests for one view | parse | joined, views in view order |
| an answer naming no view | parse | the comment as written for all four views |
| an off-schema answer | parse | `AnalysisMalformedError`; asked once more, then the comment as written for every view |
| no product type | message | `Product: product.` |
| a Bedrock entry, a guardrail configured | request | only the JSON-quoted comment is `guardContent` |

## Prompt and view planning

| Given | When | Then |
|---|---|---|
| front | plan | images sketch[, material sample]; one studio photograph, one of four views, the product type named in the opening |
| further material images | plan, prompt | after the design references in the sketch images; the opening says which of them are other materials, not views (G6) |
| any spec, any view, with or without a sample | prompt | no garment, fabric, sleeve, neckline, hem, collar, swatch or chest-height wording |
| any product | prompt | shown alone, standing or resting as in use, no person, body, mannequin, hands, stand or prop unless the sketch draws one; a soft object keeps its in-use shape |
| a view the sketch does not draw | plan | front render (and back render for profiles) only, no material sample; render decides everything; with a sample, no written material or colour |
| a view the sketch draws | plan | sketch, material sample, front render[, back render], in that order; must agree with the front photograph |
| two profiles | prompt | opposite camera texts and the mirror-opposites sentence |
| corrections > 4 / requests > 6 | prompt | first four corrections; requests last, overruling inputs, the most recent six |
| several uploaded images | prompt | "the first N attached images … together they are the sketch"; sample and renders numbered after |
| design references all photos | prompt, every view | called the photo(s) of the product; they decide shape and construction and, unless a sample or written inputs say otherwise, colour and material; no drawing rules and no "sketch" wording; people, hands, other objects and background left out (G7) |
| sketches and photos | prompt | the opening names each attached image; the sketch decides construction, the photos the real look (G8) |
| no `views` on the spec | prompt | "may show the front alone, or the front and the back side by side" |
| an absent field | prompt | line omitted, never invented; no product type → `product` |
| supplied dimensions | prompt | `- Dimensions:` line and "at the dimensions given" |
| a product type starting with a vowel | prompt | `an` (`a sketch of an espresso machine`) |
| any material text | prompt | one generic material guidance (rigid and soft parts), never a table of material names |
| parts or details on the spec | prompt | listed with their location, followed by the line keeping every print, logo, graphic or text |
| `ignored` marks on the spec | prompt | `On this sketch, leave out: …` after the generic leave-out sentence |
| `IMAGE_SIZE` / `IMAGE_QUALITY` | settings | override when offered, else registry default; an unoffered value throws naming the options |

## Image adapters

| Given | When | Then |
|---|---|---|
| a gateway entry with references | call | `/v1/images/edits`, repeated `image` parts, sketch first, registry defaults sent, override replaces default |
| a direct OpenAI entry with several images | call | `https://{region}/v1/images/edits`, snapshot id, `image[]` parts, org/project headers when set |
| `moderation_blocked` or `image_generation_user_error` (any status) | call | `ContentRefusedError` |
| quota 429 / 401 / 403 | call | `ProviderAccessError`, no status for the retry policy |
| 429 rate limit / 503 | call | provider error with the status; key never in the message |
| unexpected body | call | response-shape error naming the model |
| key in env and secret | config | env wins, secret not read; neither → message naming both |
| an OpenAI adapter given a gateway entry; a Bedrock image entry | dispatch | refused; throws, no fall-through |

## Critic

| Given | When | Then |
|---|---|---|
| a view, a sketch and a material sample | critic | one comparison call, images labelled `Sketch`, `Generated image ({view} view)`, `Material sample`, in that order; token floor 3072 |
| every aspect `same` | judge | `pass`, scores 1, no confirmation |
| a part described in other words, answered `same` | critic | `match`, `pass` |
| `shape`, `proportions`, a part or `material` `different` | judge | `warn`, one call, the issue kept naming both descriptions and the reason |
| `cant_tell` on any aspect, hard ones included | judge | neither fails nor warns; out of the scores |
| `object_type` or `color` `different`, or the image unusable or quality < 0.5 | critic | a second call, same prompt and images, at temperature 0.7 (the first keeps the entry's); `fail` only on the facts both answers fail on, `confirmation {failedOn, confirmed}` |
| a second answer that disagrees | critic | `warn`, issue ends `a second reading disagreed`, result confidence 0.5 |
| no supplied colour and no sample | prompt | `color` not asked; with either, asked against them, `never the sketch` |
| an observed spec field | prompt | not a fact, not a reference |
| a changed aspect (`parts` included) | prompt | not asked |
| any view | prompt | no garment, fabric, sleeve, neckline, mannequin or swatch wording; the spec quotes the front prompt verbatim |
| the answer schema | inspect | no union, no optional property |
| parts beyond 12; problems beyond 6 | judge | dropped, not refused |
| scores | judge | must 3, should 2; parts count once with their share of `same` |
| undecodable candidate bytes | critic | throws before any call; no verdict |
| an answer outside the schema | critic | error naming the model |
| a request confidently not applied / doubtfully not applied / no request | critic | `fail`, named first, not confirmed / `warn` / no request call |
| a request answer with the wrong count | critic | error, for the step to retry |
| an image larger than 1568 px | critic | sent within 1568 px as JPEG |
| a schema violation | runner | correction turn, usage summed; after 3 wrong answers fails with the issues as cause; a stop reason other than `end_turn` is never corrected |
| a request token floor | runner | raises `maxTokens` above the entry (default 4096), never lowers it |
| a request temperature | runner | sent instead of the entry's |

## Pipeline

| Given | When | Then |
|---|---|---|
| image-only package | intake | spec observed from the images; every intake stage emits `running` then `passed` |
| metadata with unknown column names | intake | reaches the spec as supplied; assumptions reach the run |
| a throttle once | analyse | retried, run continues |
| three timeouts, or three off-schema answers | analyse | stage and run fail after three attempts |
| an unreachable gateway | stage | retried, each attempt logged with its cause and ` (retry N)` in the message |
| an unresolvable host | stage | fails at once, logged as error with its code |
| a passing stage | logs | one info line, nothing at warn or error |
| a failing run | end | `failureReason` on the revision, logged once |
| an error the run cannot record | end | logged, then rethrown |
| a valid package / object over 3.75 MB (HEAD only, not downloaded) / > 8000 px / gif / missing object / several bad files | validate | pass with size and dimensions / rejected naming each file and limit, all in one error |
| a failed left profile, budget 3 | loop | steps exactly `generate_2d-front-1, generate_2d-back-1, generate_2d-left-1, generate_2d-right-1, record_2d-1, evaluate_2d-1, generate_2d-left-2, record_2d-2, evaluate_2d-2, select-2`; 5 image calls; the retry scores only the left; kept views delivered |
| a failed front / a failed back | loop | all four remade, the front with its corrections / back and both profiles remade |
| every view at one size | loop | each request uses the attempt's size and quality |
| no decision before the review timeout | review gate | `review-failed` step, `human_review failed "No review decision: …"`, run failed with that reason |
| all attempts of the default budget rejected | loop | best attempt selected, `criticOutcome.approved = false`, the run parks at review |
| an approved attempt | loop | `criticOutcome {approved: true, attempt, attempts, issues: []}` |
| attempts with verdicts | `bestAttempt` | most views not failed, then mean score, then the latest |
| regenerate (left), regenerate (front), approve | run | review/triage/generation steps exactly `generate_2d-{front,back,left,right}-1, human_review, record-review, triage-1, generate_2d-left-2, human_review-2, record-review-2, triage-2, generate_2d-{front,back,left,right}-3, human_review-3, record-review-3`; no step name repeats; earlier requests resent when a view is remade; a dependant view with no requests of its own gets no REQUESTS section; no `evaluate_2d` after the first generation; `criticOutcome {evaluated: false, attempt: 3}`; the last round's views delivered; messages `Regeneration 1: remaking the left side.` and `Regeneration 2: remaking the front, the back, the left side, the right side.` |
| any transient error class listed in [03](03-orchestration.md#retry-classification) | `isTransient` | true; terminal classes false, read through the cause chain, outermost verdict first, depth-bounded |
| a transient failure | retry strategy | attempts 1 and 2 retry with fixed, increasing delays; attempt 3 does not |
| env values unset, empty, blank, `NaN`, 0, negative, fractional, `Infinity`, ` 3 ` | positive int | default for all but the last, which is 3 |
| a sixteen-aspect evaluation (aspects and `part: …` rows), all mismatched | stage detail | fits the budget, lists only mismatches |
| a guardrail configured; notes at submit; a regenerate decision | run | `ApplyGuardrail` (source `INPUT`) on, in order: product ID, file names, product details, design notes (validate); the guidance requests (triage-guidance); the review notes, then its requests (triage-1) |
| design notes the guardrail blocks | run | `validate` fails once (not retried) with `Design notes: blocked by the content guardrail (prompt attack).`; no analyse step; the run fails with that reason |
| per-view requests the guardrail blocks | run | the triage step fails once; no image call |
| a payload with hidden characters | run | screened and triaged clean |
| `GuardrailBlockedError`, bare or wrapped in `StageFailed` | `isTransient` | false |
| no `GUARDRAIL_ID` | cold start | one warning; nothing screened; requests unchanged |
| a critic call, a guardrail configured | request | `guardrailConfig`; only the quoted supplied facts and requests in the system prompt are `guardContent`; labels and images unwrapped; `guardrail_intervened` → `GuardrailBlockedError`, no correction turn |

## API

| Given | When | Then |
|---|---|---|
| the dispatch table and the IaC route list | compare | identical |
| settings the model offers | submit | stored on the revision and in the durable payload; `attemptBudget` replaces the deployment's |
| a size, quality or complexity the model does not offer, or `attemptBudget` 9 | submit | 400 before any revision or execution |
| an unknown route key / an unexpected throw | handler | 404 naming the key / 500 naming only the request id |
| no verified `sub` | any route | 401 before the store is touched |
| a non-JSON or base64 body | parse | 400 / decoded first |
| a confirm key not minted by presign | confirm | 400 |
| a non-owner read | read | 403, not 404 |
| an image-only submit | submit | one revision, one execution named after it, payload valid against the pipeline schema |
| no image / invalid or empty metadata / removed roles | submit | 400 before any revision or execution |
| regenerate without notes / after 3 regenerations | review | 400 / 409 |
| a `candidateId` other than the selected front | review | 409, nothing sent to the pipeline |
| a regenerate note the guardrail blocks | review | 400 `notes: Review notes: blocked by the content guardrail (prompt attack).`, screened after sanitising, no callback |
| a submit with hidden characters in the product id, a file name, the details and the notes | submit | stored and forwarded clean |

## Web

Sign-in carries an unguessable `state` and `nonce`; a mismatched, absent or replayed `state`, or
a callback with nothing pending, is refused without an exchange; `?error=` is surfaced; a deep
link survives. Canvas: one node per stage in order, prompt spliced into the spec → generate hop,
the retry edge returns to the prompt, groups in distinct non-overlapping columns, taller cards
push others down. Prompt diff: an appended clause is one run; a replaced word shows removed and
added. The title is `Sketch to product views`, prefixed `● Ready for review — ` while a finished run
waits unseen. Replay: scrubbing to the end returns the live document; derived fields appear only once
their event happened; a rejected view is a retry, not a failed run. Start form and review gate:
a field is replaced by its sanitised text on blur, with `{n} hidden or control character(s)
removed.` when any were.

## Free smoke test

Run the real handler in-process with a local durable context and a file store, and point the
image provider at a local stand-in for `/v1/images/edits` that answers with the first image it
was sent, resized to the requested size (reference: `npm run 2d -- --sketch front.jpg
--fake-images --auto-approve`). The analyser, the critic and the retry loop run for real (Bedrock
credentials needed), image calls cost nothing, and **the critic should reject every view** (a
sketch is not a studio photo): expect two attempts, `approved: false`, a review gate, then
delivery on auto-approve. The run folder holds `state.json` (the full revision) and an HTML
report refreshed during the run. Before any paid run, print the exact prompts, inputs and number
of image calls.
