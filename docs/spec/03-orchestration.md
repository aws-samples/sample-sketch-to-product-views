# 03. Orchestration

The pipeline is one [AWS Lambda durable function](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
execution per revision. Reference implementation: `pipeline/src/handler.ts`, on
`@aws/durable-execution-sdk-js` (`withDurableExecution`, `ctx.step`, `ctx.parallel`,
`ctx.waitForCallback`).

## Durable-execution rules (normative)

1. **Non-determinism only inside steps.** Clock reads, UUIDs, store writes and every model call
   run inside a step; their results are checkpointed and replayed. Code between steps is pure.
   Environment variables may be read outside steps (a published version's configuration is
   immutable).
2. **Step names are unique within an execution and stable across replays.** They encode the
   stage, the view, the attempt and the review round (table below). Two steps with one name would
   let attempt 2 replay attempt 1's rejected result.
3. **No nested durable operations.** Event emission happens inside the step it belongs to, not as
   its own step.
4. **State flows through step results only.** Loop state (previous verdicts, attempts tried,
   regenerations) is rebuilt from replayed step results, never from closure mutation.
5. **Checkpoints hold decisions, not payloads.** A step returns ids, keys, verdicts and text,
   never image bytes or presigned URLs. Durable storage per execution is capped at 100 MB and
   1 MB per operation, neither raisable
   ([Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)).
6. **Log through the step or context logger** (replay-aware); a bare console line outside a step
   repeats on every replay.
7. **Payload sanitised and validated at entry**: `sanitizeSubmitBody` (idempotent; the API ran
   it too), then `PipelineInput` ([02](02-data-contracts.md#free-text-sanitisation)).

## Step names

| Step | Name | Notes |
|---|---|---|
| validate | `validate` | |
| analyse | `analyse` | |
| complete spec | `complete_spec` | |
| design-notes routing | `triage-guidance` | emits on stage `complete_spec`; only when notes were submitted |
| generate a view | `generate_2d-{view}-{attempt}` | |
| profiles batch | parallel operation `views-{attempt}`, branches named `left` / `right` | branches run `generate_2d-left-{attempt}` / `generate_2d-right-{attempt}` |
| record views | `record_2d-{attempt}` | one write for back and profiles |
| evaluate | `evaluate_2d-{attempt}` | all views of the attempt |
| select | `select-{attempt}` | |
| review wait | `human_review` (round 0), `human_review-{round+1}` later | callback wait |
| record review | `record-review`, `record-review-{round+1}` | |
| triage | `triage-{round}` (1-based) | emits on stage `human_review` |
| deliver | `deliver` | |
| failure | `mark-failed` | |

Example, a first generation where only the left profile fails once (budget 3):
`generate_2d-front-1, generate_2d-back-1, generate_2d-left-1, generate_2d-right-1, record_2d-1,
evaluate_2d-1, generate_2d-left-2, record_2d-2, evaluate_2d-2, select-2`.

## The stage wrapper

Every stage step does, inside the step:

1. emit `running` with the opening message (suffixed ` (retry N)` when the SDK step attempt
   `N+1 > 1`), the generation `attempt` and `view` when relevant, and the stage's input detail;
2. run the work;
3. on success emit `passed` with the result message and detail, log `info` `stage_passed`;
4. on failure wrap the error as `StageFailed(stage, summary, cause)`, log `warn` (will retry) or
   `error` (will not) `stage_failed` with the structured error, emit `failed` with the summary
   (plus the retry suffix) and the input detail, then rethrow.

Log fields: `revisionId`, `stage`, `step`, `stepAttempt`, `generationAttempt`, `view`, `model`
(`{id, provider, region}`), `durationMs`, and on failure `willRetry`, `reason`, `error`.

## Retry classification

Each step uses one retry strategy: transient → back off; anything else → no retry.

An error is **terminal** when, anywhere in its `cause` chain (depth ≤ 5), it is: a package
validation error, a content refusal by the image provider, an analysis refusal
(`AnalysisInvalidError`), a guardrail block (`GuardrailBlockedError`), or a provider access error (401, 403, exhausted quota or billing).
Otherwise it is **transient** when the first link (outermost first) satisfies any of:

- the AWS SDK marked it `$retryable`;
- its name or `code` is one of: `AnalysisMalformedError`, `ThrottlingException`,
  `ThrottledException`, `TooManyRequestsException`, `ProvisionedThroughputExceededException`,
  `RequestLimitExceeded`, `RequestThrottled`, `RequestThrottledException`, `SlowDown`,
  `InternalServerException`, `InternalServerError`, `InternalFailure`, `InternalError`,
  `ServiceUnavailableException`, `ServiceUnavailable`, `ModelNotReadyException`,
  `ModelTimeoutException`, `RequestTimeout`, `RequestTimeoutException`, `TimeoutError`,
  `NetworkingError`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`, `EAI_AGAIN`,
  `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET`
  (`ENOTFOUND` is deliberately absent: an unresolvable host is configuration);
- its HTTP status (`$metadata.httpStatusCode`) is 408, 429, 500, 502, 503 or 504.

The terminal check runs on each link before the transient checks of that link, so a terminal
error wrapping a throttle stays terminal, and a throttle wrapping a refusal is transient (the
outermost verdict wins). A non-Error value, an unknown error and a bare `StageFailed` with no
cause are terminal: fail fast is the safe direction for a paid call.

**Backoff:** at most 3 attempts per step, initial delay 2 s, rate 2, maximum 20 s, **no jitter**
(the strategy is evaluated outside a step, so it must be deterministic): delays 2 s then 4 s.
Provider SDK retries must not stack on this: HTTP providers are called with plain `fetch` and no
client retries; Bedrock clients use 1 attempt (analyser) or 2 (critic).

## Algorithm

```text
run(event):
  input = parse PipelineInput(event)
  try:
    runRevision(input); return { revisionId, status: "approved" }
  catch e:
    step "mark-failed": log error run_failed; patch { status: "failed", failureReason: summary(e) }
    return { revisionId, status: "failed", reason }
  (an error not turned into a failed revision is logged unhandled_error, then rethrown)

runRevision(input):
  seg  = revSegment(input.createdAt, input.revisionId)
  spec = intake(input)                                   // validate, analyse, complete_spec
  budget = positiveInt(ATTEMPT_BUDGET, 2)
  guidance = input.requests ? routeGuidance(notes) : none
  accepted = twoDLoop(spec, budget, guidance)
  regenerations = []
  for round = 0, 1, …:
    decision, reviewedBy = review(accepted, round)
    if decision = approve: break
    if |regenerations| ≥ MAX_REGENERATIONS (3): fail StageFailed(human_review,
       "Reviewer asked to regenerate after the 3 regenerations a run allows.")
    r = triage(decision.notes, reviewedBy, round = |regenerations|+1); append r
    accepted = regenerate(accepted, asked = r.views[*].view,
                          requests = requestsByView([guidance?] + regenerations))
  deliver(accepted)
```

`positiveInt(name, fallback)`: the variable parsed as a number; used only when it is an integer
> 0, else the fallback (unset, empty, blank, `NaN`, 0, negative, fractional, `Infinity` all fall
back; surrounding whitespace is tolerated).

### Intake

| Step | Work | Patches | Message |
|---|---|---|---|
| `validate` | package rules, then each file sequentially: HEAD for size (reject before download), GET, sniff type, decode for format and dimensions ([02](02-data-contracts.md#input-package)); collect every failure, then throw one validation error naming every bad file; then screen the submitted text ([below](#guardrail-screening)) | — | `{n} file(s) present, readable and within the model limits.` (detail fact `guardrail`: `{k} field(s) screened` or `off`) |
| `analyse` | read every input in upload order, the material sample among them, call the analyser ([04](04-analysis.md)), which decides what each one is; no sketch or photo of the product is terminal | `analysis` | `{k} image(s) read[ ({kinds, lower-cased labels joined ", "})]: {views or "no view"}; {d} detail(s).` |
| `complete_spec` | `completeSpec` and `warningFor` with `hasMaterial` (`planImages` finds a material sample: the analyser's decision, or a stored run's `swatch` role) | `spec`, `warning` | `Supplied: a, b. Observed: c.` (spec field keys in `SPEC_FIELDS` order: `productType`, `materialDescription`, `colorDescription`, `dimensions`), or `Nothing supplied or observed; the images alone describe the product.` |

Per-file validation messages: `{file} has no storage key and cannot be read.`,
`{file} could not be read from storage.`, `{file}: too large: {x.xx} MB, the limit is 3.75 MB.`,
`{file} is not a readable JPEG, PNG or WebP.`, `{file} could not be decoded as an image.`,
`{file}: {issues joined "; "}.` where issues are `unsupported format: {f} (need jpeg, png or webp)`,
`{w} px wide, the limit is 8000 px per side`, `{h} px tall, the limit is 8000 px per side`.

`{labels}` in messages means each view as `the {view label}`, joined with `, `.

Opening messages: `Reading each input from storage.`, `Reading the images and the product
details.`, `Building the specification from the analysis.`, `Reading which views the design team
notes concern.`.

### Guardrail screening

With `GUARDRAIL_ID` and `GUARDRAIL_VERSION` set ([11](11-infrastructure.md#configuration)),
every user-written string is screened by the Amazon Bedrock guardrail at least once before any
model reads it. Two mechanisms:

- **`ApplyGuardrail`** (`source: INPUT`, one call per field, in parallel; `screenText` in
  `shared/src/guardrail/index.ts`), for text that reaches a model outside Bedrock (an OpenAI or
  gateway analyser, the image model) and wherever an early rejection is clearer;
- **Converse `guardrailConfig`** (`{guardrailIdentifier, guardrailVersion, trace: "disabled"}`)
  on every Bedrock call, with only the user text in `guardContent` blocks
  ([04](04-analysis.md#guardrail), [07](07-critic.md#guardrail), [08](08-feedback-triage.md#guardrail)).

| Point | Text | Mechanism | On a block |
|---|---|---|---|
| `POST …/review` (API) | review notes of a regenerate decision | `ApplyGuardrail` | 400 `notes: Review notes: blocked by …`; no callback, the gate stays open ([10](10-api-and-ui.md#review)) |
| `validate` | product ID, file names (joined by `\n`), product details, design notes | `ApplyGuardrail`, a field each | stage fails |
| `analyse` | file names (as quoted), product details | Converse `guardContent` (Bedrock analyser) | stage fails |
| `triage-guidance`, `triage-{r}` | the notes (as quoted) | Converse `guardContent` (Bedrock analyser) | stage fails |
| `triage-{r}`, before the call | review notes, again (the callback crosses a trust boundary; the CLI has no API) | `ApplyGuardrail` | stage fails |
| `triage-guidance`, `triage-{r}`, after the call | the per-view requests (joined by `\n`), which go into the image prompt and the critic | `ApplyGuardrail` | stage fails, before any image call |
| `evaluate_2d` | supplied facts and requests in the critic's system prompt | Converse `guardContent` | stage fails |

A block is a `GuardrailBlockedError`, terminal, with a message naming the field and the
policies and never the text: `{Field}: blocked by the content guardrail ({policies}).` (policies
from the `ApplyGuardrail` assessments: `prompt attack`, `hate`, `insults`, `sexual`, `violence`,
`misconduct`), or `{Analyser|Triage|Critic …} call: blocked by the content guardrail.` for a
Converse `stopReason` `guardrail_intervened` (trace off, so no policy). The stage's `failed`
event and the run's `failureReason` carry it. Unset `GUARDRAIL_ID` → nothing is screened, and
each function logs one warning at cold start; a `GUARDRAIL_ID` without `GUARDRAIL_VERSION` fails
the cold start.

### Design notes (guidance)

When the submit carried notes, step `triage-guidance` (stage `complete_spec`) routes them with the
same triage call as a regeneration ([08](08-feedback-triage.md)), patches `guidance`
`{notes, views, attributes, reviewedBy?}` and emits `Design team notes sent to {labels}.`
Every image of a view made later is given that view's guidance requests, and the critic is told
the changed aspects (critic aspect names, [07](07-critic.md)), which it stops asking.

### The generate-and-evaluate loop (first generation)

```text
twoDLoop(spec, budget, guidance):
  previous = none; tried = []
  for attempt = 1 … budget:
    failed(v)  = previous and previous.verdict[v] = fail
    redoFront  = previous is none or failed(front)
    redoBack   = redoFront or failed(back)
    redoProfiles = [p in left,right where redoBack or failed(p)]
    views = makeAttempt(attempt, "Attempt {attempt} of {budget}", previous.views,
                        redoFront, redoBack, redoProfiles,
                        corrections(v) = previous.verdict[v].issues if failed(v) else none,
                        requests = guidance.requestsByView)
    step "evaluate_2d-{attempt}":                       // one step, views scored in parallel
       for each view: if made in this attempt → critic(view, requests[view], guidance.changed)
                      else keep its previous verdict (its image did not change)
       patch the new verdicts onto the candidates of this attempt
       message: "front pass | back fail: issue; issue | …"
    previous = (views, verdicts); tried += (attempt, views with verdicts)
    if attemptVerdict(verdicts) ≠ fail: return select(this attempt, approved = true)
  return select(bestAttempt(tried), approved = false)
```

- `attemptVerdict`: any `fail` → fail; else any `warn` → warn; else pass. `warn` is accepted:
  that is what human review is for.
- `bestAttempt`: most views not failed (a `warn` counts as approved), then the higher mean over
  its views of the mean of the three scores, then the later attempt.
- `select-{attempt}` patches `selectedCandidateId` (the front's id), `selectedViews` (view → id),
  `attempt`, and `criticOutcome {approved, attempt, attempts: |tried|, issues}`. Issues are empty
  when approved; otherwise the failed views' issues, trimmed, front first, de-duplicated, at
  most 5. When not approved it also emits `evaluate_2d` `passed` with
  `The critic rejected all {n} attempt(s); attempt {k}, the best, goes to review.`

### Making one attempt

```text
makeAttempt(attempt, label, last, redoFront, redoBack, redoProfiles, corrections, requests):
  settings = imageSettings(entry, IMAGE_SIZE, IMAGE_QUALITY)   // same for every view; invalid → fail before any call
  front = redoFront ? step generate_2d-front-{attempt} (append its candidate in the same step) : kept(front)
  back  = redoBack  ? step generate_2d-back-{attempt} given front : kept(back)
  parallel "views-{attempt}" over redoProfiles: step generate_2d-{p}-{attempt} given front and back
  if any branch failed: throw StageFailed(generate_2d, branch summaries joined " | ", cause = first)
  step record_2d-{attempt}: append [back if remade] + profiles in one write
  return [front, back, left, right]  (kept views from `last`)
```

- A view is made from the ones before it, so it can only start once they exist: front →
  back → both profiles together.
- Opening message: `{label}{" with {model name}" for the front}: the {view label}, {from}.` where
  `from` is `from the sketch[ and the material sample]` (front), `from the front render[, the
  sketch[ and the material sample]]` (back), `from the front and back renders[, the sketch[ and
  the material sample]]`
  (profiles); the sketch clause appears only when the sketch draws that view. View labels:
  front, back, left side, right side. Result message: `{View} view produced in {s.s}s.`
- **Candidate list writes.** Single writer at a time: the front's step writes its own candidate;
  parallel branches write nothing; `record_2d` writes the rest at once. Appending first drops
  entries with the same `(attempt, view)` (a step retried after its write, before its
  checkpoint), so a retry replaces only its own earlier try.

### Regeneration

One attempt, **unscored**, numbered after the **last attempt made** (`lastAttempt + 1`, carried on the accepted attempt;
not after the attempt kept, which may be an earlier one) so no step name
repeats. `redoFront = asked(front)`, `redoBack = redoFront or asked(back)`, profiles
`redoBack or asked(p)`. No corrections; each remade view gets every request its view has had
(guidance included). Label `Regeneration {round}`. Then `select-{attempt}` patches the selection
and `criticOutcome {evaluated: false, attempt}`. No `evaluate_2d` step or event. A view remade
only because it is derived from a changed one gets its own (possibly empty) request list.

### Review gate

```text
review(accepted, round):
  days = positiveInt(REVIEW_TIMEOUT_DAYS, 7)
  rejected = accepted.unscored ? [] : views whose verdict is fail
  raw = waitForCallback(name(round), submitter, timeout = days)   // on throw, see below:
     submitter(callbackId): store callbackId on the revision (never in the document);
                            patch status awaiting_review;
                            emit human_review awaiting_review
                            "Candidate {first 8 of front id} is waiting for a decision.[ The critic still rejects {labels}.]"
  body = JSON.parse(raw); decision = parse ReviewDecision(body)     // validated again here
  reviewedBy = body.reviewedBy if string
  step record-review…: patch status running; emit human_review passed "Reviewer chose to {decision}."
                       with detail {input: {candidateId, waitedDays}, output: decision}
```

A timeout (or a failure callback) makes the wait throw. Step `review-failed` (suffixed like the
other review steps from round 2) emits `human_review failed "No review decision: {summary}"`,
then the stage fails and the run is marked failed with that reason. The
callback payload crosses a trust boundary and is validated in the API and again here.

Triage (`triage-{round}`) patches `regenerations` (all rounds so far) and emits
`Regeneration {round}: remaking {labels of viewsToRemake(asked)}.`, for example
`Regeneration 2: remaking the front, the back, the left side, the right side.`

### Delivery

Step `deliver` (stage `deliver`), opening `Publishing the approved views.`: for each view of the
accepted attempt, read its bytes, write them under the delivery key with the sniffed content type
(default `image/png`), then patch `status approved`, `deliveryKey` (front), `deliveryKeys`.
Message: the delivered file names joined by `, `. A view without a stored key fails the stage.

## What the API records

At submit, before invoking, the API emits `upload passed` `{n} file(s) received.` and
`submit passed` `Revision 1 manifest recorded.`, then invokes the alias with
`InvocationType: Event` and `DurableExecutionName = revisionId`, which makes a retried submit
join the same execution
([execution names](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)).
