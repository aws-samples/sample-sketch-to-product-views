# The pipeline as a Lambda durable function

One run of the 2D pipeline is one durable execution of `pipeline/src/handler.ts`. The run can
wait days for a human decision, so it cannot fit in one Lambda invocation. Durable execution
checkpoints each step and replays the handler from the checkpoints when it resumes
([Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)).

The design follows the
[`aws-lambda-durable-functions` skill](https://github.com/aws/agent-toolkit-for-aws/tree/main/skills/specialized-skills/serverless-skills/aws-lambda-durable-functions).

## Runtime and packaging

- Runtime `nodejs24.x` on arm64. SDK `@aws/durable-execution-sdk-js`; the handler is wrapped in
  `withDurableExecution`.
- The bundle is a directory: esbuild output plus the vendored linux-arm64 `sharp` binary used by
  upload checks and the critic's image preparation (`pipeline/scripts/vendor-sharp.sh`).
- Durable execution can only be enabled when a function is created, not on an existing one
  ([Configure durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-configuration.html)).
  `infra/modules/pipeline` sets `durable_config` from the first apply.

## Invocation

| Concern | Decision |
| --- | --- |
| Identifier | Qualified only. Terraform publishes a version and a `live` alias; the API invokes `<name>-pipeline:live`. Unqualified identifiers are rejected, and an execution stays pinned to the version that started it ([Invoking durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html)). |
| Type | `Event` (asynchronous). Asynchronous invocations support executions up to one year; synchronous ones are limited to 15 minutes. |
| Idempotency | `DurableExecutionName = revisionId`. A double submit cannot start a second execution for the same revision. |

## Handler shape

```text
withDurableExecution(async (event, ctx) => {
  validate, analyse, complete_spec                  // one ctx.step each
  [triage of submit-time notes]                     // only when notes were given
  for attempt in 1..ATTEMPT_BUDGET:                 // twoDLoop
    generate_2d-front-<n>, generate_2d-back-<n>
    ctx.parallel(left, right)
    evaluate_2d-<n>                                  // views scored in parallel
    stop when every view passes
  loop:
    ctx.waitForCallback('human_review[-k]')          // approve, or regenerate with notes
    approve -> break
    regenerate -> triage, remake the asked views and their dependants
  deliver
})
```

A stage failure ends the run in a `mark-failed` step that records the reason on the revision.

## Replay rules

1. **Non-determinism lives inside steps.** IDs, timestamps, DynamoDB and S3 writes, and every
   model call run inside `ctx.step`. Anything outside a step gives a different value on replay.
2. **Step names are unique and stable.** The name carries the stage, the view and the attempt
   (`generate_2d-back-2`), and each review round has its own suffix. Two steps with one name
   would let attempt 2 replay attempt 1's rejected image. Tests look steps up by name, never by
   index.
3. **State flows through step results.** Closure mutations are lost on replay. The retry loop
   rebuilds its state from replayed results.
4. **Checkpoint keys, not bytes.** Steps return S3 keys and model IDs. Image bytes are read back
   from S3 where needed. Presigned URLs are minted by the API on demand and never checkpointed.
5. **No secrets or personal data in step results.** They are persisted as checkpoints.
6. **Environment variables are read outside steps.** A published version's configuration is
   immutable, so the value is the same on every replay.

## Retries

Each step has a retry strategy (`retryStrategy` in the handler): 3 attempts, 2 s initial delay,
doubling, capped at 20 s, with jitter off so the schedule cannot differ on replay. Only
transient errors retry: throttling, timeouts, 5xx, a malformed analyser answer. A moderation
block, an exhausted quota, a 401 or 403, or an invalid package fails at once. The model clients
use plain `fetch` (OpenAI) or at most two SDK attempts (Bedrock), so client retries do not stack
on the step's.

The generate-and-evaluate loop is a separate budget (`ATTEMPT_BUDGET`, default 2). It remakes
only the failed views and the views derived from them, with the critic's issues (up to 4) in
the prompt.

## The review gate

`ctx.waitForCallback('human_review', submitter, { timeout: { days: REVIEW_TIMEOUT_DAYS } })`.
The wait uses no compute.

```text
submitter        -> writes the callbackId on the revision, status awaiting_review
POST /api/revisions/{id}/review
                 -> API reads the callbackId
                 -> lambda:SendDurableExecutionCallbackSuccess { CallbackId, Result }
```

- The callback ID stays server-side; it is never sent to the browser.
- The decision crosses a trust boundary. The API validates it against `reviewDecisionSchema`
  (`contracts/`), and the pipeline validates it again. The reviewer identity comes from the
  verified JWT claims, never from the request body.
- Decisions are `approve` or `regenerate` with notes. A regeneration routes the notes to the
  views they concern (one analyser call, `shared/src/analyse/feedback-triage.ts`), remakes
  those views and their dependants, and returns to the gate. A run allows 3 regenerations.
  Regenerated views are not re-scored by the critic: the reviewer is the judge at that point.
- A gate nobody answers within the timeout fails the run with a stated reason.

The API role has `lambda:SendDurableExecutionCallbackSuccess`, `...Failure` and `...Heartbeat`
on the pipeline function.

## Configuration

| Setting | Value | Why |
| --- | --- | --- |
| `execution_timeout` | `review_timeout_days` (default 7 days) | Bounded by the review gate. Valid range 1 s to 366 days. |
| `retention_period` | `review_timeout_days` | Keeps the checkpoint history as long as the review window. Valid range 1 to 90 days, default 14. |
| Function `timeout` | 900 s | One invocation can hold a front call, then back and profiles. A slice cut short resumes from the last checkpoint. |
| Log format and level | JSON, application `INFO`, system `INFO` | `DEBUG` would log replay internals and step data. |
| Log group | Declared in Terraform, KMS-encrypted, `log_retention_days` | Retention and key under Terraform's control from the first invocation. |
| Tracing | AWS X-Ray active | |

Ranges from the [DurableConfig API reference](https://docs.aws.amazon.com/lambda/latest/api/API_DurableConfig.html).
`DurableConfig.KMSKeyArn` is set to the data key, so inputs, checkpoints, results and callback
results are encrypted with it; the key policy lets the Lambda service principal use it for this
function only ([durable encryption](https://docs.aws.amazon.com/lambda/latest/dg/durable-encryption.html)).

The execution role attaches `AWSLambdaBasicDurableExecutionRolePolicy` and X-Ray write access,
plus least-privilege statements for the table, the artifacts bucket, the data key, Bedrock
invoke and the named secrets.

## Logging and events

- Use `ctx.logger` and `step.logger`. They are replay-aware, so a replay does not repeat log
  lines. A bare `console.log` outside a step repeats on every replay.
- Each stage attempt logs one line: `info` on pass, `warn` on a failure that will retry,
  `error` otherwise.
- The stage-event log in DynamoDB is what the web UI shows. `emit()` is the only way a stage's
  status changes, and it runs inside a step.

## Testing

- `pipeline/test/fakes.ts` provides an in-memory durable context. It runs each step once and
  asks the step's own retry strategy whether to retry, as the SDK does, minus the delay. It
  runs `parallel` branches together. The store is backed by maps.
- Tests cover the retry loop and the attempt budget, the review loop (approve, regenerate,
  regeneration limit), retry classification, and step names.
- `cli/src/local/context.ts` is the same idea for `npm run 2d`: a real run in-process, with
  `waitForCallback` parked on a terminal prompt. Nothing is checkpointed.
- `npm test` runs with fake AWS credentials and no OpenAI key, so no test can call a paid model.

## Model placement

All infrastructure is in us-east-1. Each model call is placed by its registry entry
(`shared/src/registry/models/`): provider, model ID, entry Region and the Regions that may
process the request (`residency`). Terraform names the entry for each call, so the provider is
a per-deployment choice.

| Stage | Default entry | Where it is processed |
| --- | --- | --- |
| validate, complete_spec, prompt | none (code) | us-east-1 |
| analyse, review-note triage | `analyser-sonnet-bedrock` (`us.anthropic.claude-sonnet-5-5`) | US geo profile from us-east-1: us-east-1, us-east-2, us-west-2 |
| generate_2d | `gpt-image-2.6-sunburst-openai` | `api.openai.com` (OpenAI API) |
| evaluate_2d | `critic-sonnet` (`us.anthropic.claude-sonnet-4-6`) | US geo profile from us-east-1: us-east-1, us-east-2, us-west-2 |

Destination Regions are from the
[Claude Sonnet 5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html)
and [Claude Sonnet 4.6](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html)
model cards. `npm run models:check` checks them against the account.

Uploaded inputs, generated views, the stage-event log, the specification, the review trail and
the durable checkpoints stay in us-east-1.

Implementation notes:

- Bedrock clients are cached per Region (`shared/src/bedrock/clients.ts`). The OpenAI client
  (`shared/src/openai/client.ts`) reads the key from `OPENAI_API_KEY` locally or from the secret
  in `OPENAI_API_KEY_SECRET_ARN` in Lambda. The Region or API host belongs to the registry
  entry, not to the call site.
- The pipeline role grants `bedrock:InvokeModel` on foundation models in every Region and on
  the account's inference profiles, because a cross-Region profile routes to several Regions.

### Choosing a Region and data residency

Pick the Region and the inference profile for your data-residency requirements, not only for
model availability. In-Region inference keeps a request in one Region; geographic profiles
(`us.`, `eu.`, ...) stay within a geography; global profiles (`global.`) can route worldwide
([cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)).
Calls to a third-party API such as OpenAI follow that provider's terms. Moving this sample to
another Region means changing the registry entries' profiles and Region, checking durable
function and model availability there, and relaxing the Region check in
`infra/envs/dev/variables.tf`.
