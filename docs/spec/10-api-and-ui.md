# 10. HTTP API and web UI

## API

One HTTP API (Amazon API Gateway HTTP API) in front of one thin Lambda function. No stage runs
here: the API presigns uploads, starts executions, serves the revision document and resolves the
review gate. Reference implementation: `api/src/`.

**Public path.** Browsers reach the API only at `/api/*` on the web UI's CloudFront distribution,
behind its AWS WAF web ACL ([11](11-infrastructure.md#resources)); the SPA calls it same-origin.
CloudFront adds an `x-origin-verify` header with a secret value; the function compares it in
constant time against the accepted values (`ORIGIN_VERIFY_SECRETS`, two during a rotation) and
answers `403 Forbidden.` **before any route runs** when it is absent or wrong, so the
`execute-api` URL is useless on its own. No configured secret refuses every request.

Every route requires a valid Cognito JWT (the API Gateway JWT authorizer; audience = the web app
client id, so the browser sends the **id token**). Routes are enumerated (no `$default`), so an
unknown path is a 404 at the gateway; a route key the function does not know answers
`404 No route for {routeKey}.` (drift between the route list and the dispatch table, which a test
compares).

Errors are always `{"error": "<message>"}`. A schema failure names its first field:
`{path}: {message}` (400). A body that is not JSON: `400 Body is not valid JSON.` (base64 bodies are
decoded first). Any unexpected throw: `500 Internal error. Request id {id}.` with the details only
in a JSON log line. The caller is `{sub, name}` from the verified claims (`name` falls back to
`sub`); no `sub` → `401 Unauthenticated.`, checked **before** anything is read or written.

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /api/models` | — | `200 {models: [...], defaultModelId}`; `cache-control: public, max-age=300` | — |
| `POST /api/uploads/presign` | `PresignRequest` | `200 PresignResponse` | 400 schema; `415 Unsupported type {t}.`; `413 File exceeds 3.75 MB.`; `400 productId: not a valid product id.` |
| `POST /api/uploads/confirm` | `{key}` | `200 {ok: true, key}` | `400 Missing key.`; `400 Not an upload key.`; `400 Upload did not complete.`; `400 Uploaded file is empty.`; `413 File exceeds 3.75 MB.`; `415 File is not a JPEG, PNG or WebP image.`; `415 File is a {sniffed}, not the declared {stored}.` |
| `POST /api/revisions` | `SubmitRequest` | `202 {revisionId}` | 401; 400 schema; `400 modelId: unknown model "{id}"`; `400 modelId: {id} is a {category} model, not an image generator`; `400 inputs: {errors}`; `400 productMetadata: {message}`; `400 settings.{key}: {id} has no {key} setting`; `400 settings.{key}: {id} does not offer {key} "{value}"; options: …`; 400 schema for an `attemptBudget` outside 1–4 |
| `GET /api/revisions/{id}` | `If-None-Match?` | `200 PipelineState` with `etag`, `cache-control: no-cache`; `304` when the ETag matches | 401; `400 Missing revision id.`; `404 Unknown revision.` (also for another user's revision) |
| `POST /api/revisions/{id}/review` | `ReviewDecision` | `202 {ok: true}` | 401; 400 schema; 404 (also for another user's revision); `403 Not your revision to review.` (owner mismatch on a revision found under the caller's key); `409 This revision is not waiting for a review decision.`; `409 candidateId: these are no longer the views awaiting review.`; `400 candidateId: approve requires an existing candidate.`; `409 This run has used its 3 regenerations.`; `409 The review gate is not ready yet. Retry in a moment.` |

### Uploads (three legs, bytes never pass through the API)

1. **Presign.** `productId` and `filename` sanitised (single-line) first. Type in {`image/jpeg`, `image/png`, `image/webp`}; size ≤ 3,750,000 bytes; `productId`
   matches `^[A-Za-z0-9][\w.-]{0,63}$` (it is interpolated into the key). Key
   `user/{sub}/product/{productId}/uploads/{uuid}/{safeFilename}` (uploads sit outside any revision prefix:
   no revision exists yet). Presigned PUT with the content type signed in, 15-minute expiry;
   `cdnUrl` is a presigned GET (1 hour). The bucket stays private.
2. **PUT** from the browser straight to object storage with that `content-type`.
3. **Confirm.** The key must match
   `^user\/[A-Za-z0-9_.:=+@-]{1,128}\/product\/[\w.-]{1,64}\/uploads\/[\w-]+\/[\w.-]+$` **and** sit
   under the caller's own `user/{sub}/` prefix (otherwise confirm would be an existence oracle for
   any object); HEAD it; read bytes 0–15 only; the
   sniffed type must equal the stored content type.

### Submit

1. Caller first. 2. Sanitise the body's text fields (`sanitizeSubmitBody`,
[02](02-data-contracts.md#free-text-sanitisation)), then parse it. 3. Model: `modelId` → registry lookup, else the deployment
default (`IMAGE_MODEL`, else registry default); category must be `image-control`.
4. Package rules; every input must have a key under the caller's own `user/{sub}/` prefix
(`400 inputs: a key is not one of your uploads.`). 5. Product details re-validated from their text, the format recomputed (the API stands between any request and
the analyser's prompt). 6. Create the revision (`owner` = caller `sub`, `attemptBudget` from
`ATTEMPT_BUDGET`, default 2). 7. Emit `upload` and `submit` passed. 8. Build the durable payload
and validate it with the pipeline's own schema. 9. Invoke the pipeline **alias** asynchronously
(`Event`) with `DurableExecutionName = revisionId`. Notes become
`requests: {notes, reviewedBy: sub}`.

### Read

Strongly consistent read under the caller's own key (another user's revision is a 404, like an
unknown id); ownership check; ETag compare; then **hydrate**: re-mint every URL from
its key (inputs, candidates, delivery front and per-view). The stored document holds keys only: a
presigned URL expires in an hour, a review can wait days.

### Review

Caller, then sanitise the notes and parse the schema, then existence, then authorization (before revealing gate state), then
status must be `awaiting_review`; a `candidateId` other than the selected front is stale (409);
approve needs the selected front to be an existing candidate; regenerate refused once 3 regenerations exist. With a guardrail
configured, a regenerate decision's notes are screened with `ApplyGuardrail`
([03](03-orchestration.md#guardrail-screening)); a block is
`400 notes: Review notes: blocked by the content guardrail ({policies}).` and no callback is sent,
so the gate stays open for a new note instead of the run failing. Read the stored callback id
(absent → 409 "not ready"), then `SendDurableExecutionCallbackSuccess` with
`{...decision, reviewedBy: caller.name, reviewedAt}`. The decision is applied by the pipeline, not
here.

### Authorization

Two boundaries. First, the key: every revision and artifact key starts with the owner's `sub`, and
the API builds it from the caller's verified `sub`. Second, two predicates over the stored `owner`:
read and review. Current policy: the owner may read and review; an empty owner matches nobody.
Revisions without an owner are no longer reachable. Review is a separate predicate so that a distinct
reviewer population (a group claim, a per-product list) changes only that function.

### Models

`GET /api/models` returns, per entry: `id, name, category, description, region, residency,
tags, params, acceptsInputs, requiredInputs, costPerCall, isDefault, promptGuide`. Plus `defaultModelId`
and `deployment: { size?, quality?, attemptBudget }` (the deployment's `IMAGE_SIZE`, `IMAGE_QUALITY`,
`ATTEMPT_BUDGET`), so the start form can show what a run gets by default.

## Web UI

A single-page app titled **Sketch to product views** (reference: React + Vite, `web/`), with
object-neutral wording throughout and no upload roles,
built with `VITE_API_URL` (empty when deployed: same-origin `/api/*`; the site origin for local
dev),
`VITE_COGNITO_URL`, `VITE_COGNITO_CLIENT_ID`. Without the Cognito variables sign-in is disabled
and requests carry no token (a deployed API rejects them).

**Sign-in.** Cognito hosted UI, authorization code with PKCE, no client secret, scopes `openid
email profile`. Verifier, `state` and `nonce` per tab in session storage, single-use; a callback
with no or mismatched `state`, or with no pending attempt, is refused before any code exchange
(login CSRF); `?error=` is surfaced; callback parameters are scrubbed while keeping the deep link.
Tokens are refreshed before expiry (one refresh for parallel requests). A 401 clears the session
and returns to the sign-in card. Accepted risk: tokens in session storage are readable by any
script on the origin; a backend-for-frontend with an HttpOnly cookie removes it.

**Start run.** Drop 1–5 images, JPEG, PNG or WebP: sketches or photos of the product and,
optionally, a sample of its material, with no role to pick (the analyser decides what each one
is), optional **Product details (optional)**: plain text or JSON, typed or loaded from a `.txt` or
`.json` file (validated in the browser, showing the exact text that will be sent and whether it
was read as JSON or plain text), optional design notes
(≤ 4000), a product id (default: first image's file name with unsafe characters replaced by `-`),
and the image model (from `GET /api/models`, filtered to image categories, preselecting
`defaultModelId`; hidden if the list fails), and the **generation settings**: one select per
`size`, `quality`, `complexity` param the chosen model declares (its options, the default marked:
the deployment's value from `GET /api/models` `deployment` when the model offers it, else the
param default), attempts before review 1–4, and the resulting "Up to {4 × attempts} image calls".
Changing the model resets the settings. Only values that differ from the defaults are sent.
On blur, the product ID, the design notes and the product details are replaced by their
sanitised text ([02](02-data-contracts.md#free-text-sanitisation)), with
`{n} hidden or control character(s) removed.` under the field when any were; file names are
sanitised before the presign. Errors are shown all at once from the shared
validators; nothing is validated before something is staged. Uploads run in parallel (presign →
PUT → confirm each), then submit.

**Run view** (`#/r/{revisionId}`, shareable; a 404 shows "That run is gone" and returns to start
after 3 s):

- Polls `GET /api/revisions/{id}` with `If-None-Match` every 1 s, every 5 s after 2 minutes, until
  the status is terminal; stops on 401/403; other errors are shown and polling continues.
- Top bar: product, revision, stages done of 9, status, and **Notify me** (asks for browser
  notification permission; hidden where `Notification` does not exist).
- Stage canvas: one node per stage in contract order, one column per group, a "prompt" artifact
  node between `complete_spec` and `generate_2d`, a retry edge from `evaluate_2d` back to the
  prompt; each card shows its latest output (the upload card the inputs, the analyse card the
  same thumbnails labelled with what the analyser read each as, and the views it found; card
  captions are short, "Material" and "Unused", with the full label in the tooltip; spec
  provenance chips and warning; per-view verdicts). Not editable. It fills the height left under the top bar (scrubber and
  closed event log below it) and fits the graph to that height on load, resize and card growth;
  a graph then wider than the pane is panned to the stage at work.
- Generation progress, derived from `events` (`stage`, `status`, `view`, `attempt`, `at`) and
  `candidates`: the `generate_2d` card and detail show the current attempt's four views, each
  waiting, generating (elapsed time), done (thumbnail once recorded), failed, or kept from an
  earlier attempt, labelled "Attempt n of N" (first generation) or "Regeneration n" (after a
  review gate). Events after a review gate belong to that round, since attempt numbers can
  repeat. The views a retry remakes follow the previous verdicts (`viewsToRemake` of the failed
  views); a regeneration's follow `regenerations[n-1].views`. The card reads running while any
  view is generating.
- Notifications: when a polled run changes status to `awaiting_review`, `approved` or `failed`
  (never on the first poll, so a reload of a finished run is quiet, and once per transition), an
  in-page toast; if the tab is hidden or unfocused, the title is prefixed (`● Ready for review —
  …`) until it is in view, and a `Notification` is shown when permission is granted. Permission is
  requested only from a user gesture (starting a run, **Notify me**), never on load.
- Inspector: per stage, every event's input/output/facts (newest first, a running timer), the
  inputs (each labelled with what the analyser read it as, its description in the tooltip),
  product details, analysis, spec with provenance (and `raw` values: Product type, Material,
  Colour, Dimensions, the views drawn, the parts drawn, the details to keep, and the marks left
  out of the images), the warning, every candidate grouped by attempt in view order with its
  verdict, issues and mismatches (each `expected …, saw …` with the critic's reason beside it;
  the `part: …` rows grouped under **Parts**; rejected attempts stay visible), guidance and regenerations, the exact prompt per view with a word-level
  diff against the previous attempt of that view, a lightbox, and one download
  per delivered view.
- Timeline scrubber: replays the document at any event `seq` by truncating the event log and
  re-projecting (derived fields shown only once their event happened); the review gate acts only
  on the live document. Live, its caption names everything in progress ("Generating left and
  right (attempt 1 of 2)", "Scoring the views", "Waiting for your review"); in replay, the event
  it is parked on.
- Review gate (status `awaiting_review`): the critic's remaining issues when `approved: false`;
  notes field (≤ 4000, required to regenerate; sanitised on blur, with the same hint; a note the
  guardrail blocks shows the API's 400 message and can be edited); **Approve** and **Regenerate with notes**
  (disabled without notes or once 3 regenerations are used; shows the count left); disabled after
  sending until the next poll shows the run moving.
