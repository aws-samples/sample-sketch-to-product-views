# 13. Decisions and open questions

Each decision: what, why, and what was rejected. Evidence comes from measurements made while
building the reference implementation on synthetic and test products, all of them garments: the
sample was first built for garments and then made object-neutral (D-26). Datasets are not
included.

## Generation

**D-01. One image per view, chained.** The front is made from the sketch and the material sample;
the back from the front render; each profile from the front and back renders. *Why:* views made
from one render agree on material and details; a profile joins the front edge and the back edge, and the
back render is the only image of the second. Costs one call's time per attempt.
*Rejected:* one sheet with three panels cut apart (badly cropped); `n` images per call (`n`
cannot assign different views); a many-view turntable (collapses onto four canonical poses);
profiles from the front alone (back edge invented).

**D-02. The sketch goes back in only when it draws that view.** A view the sketch does not draw
gets the render(s) alone, and with a material sample the written material and colour are dropped.
*Why:* a second statement of construction or material competes with the render and the model
blends them.

**D-03. Camera stated per view; profiles told they are mirror opposites**, with which image edge
the front faces. *Why:* left and right profiles are otherwise easily swapped or copied. No
per-detail side rules: brittle, and there is no human to correct them per product.

**D-04. The prompt is a deterministic template.** *Why:* durable retries replay the same prompt,
every prompt is diffable, and a wrong image points at the template or the inputs. *Rejected:* an
LLM writing the image prompt (non-reproducible, opaque).

**D-05. Source precedence** ([01](01-overview.md#source-precedence)). The material sample decides
colour, material, finish and pattern and wins over written colour, because where the two disagree
the image model blends them. A sketch is often drawn in an arbitrary colour, so its colour is never
the colourway. Placed artwork stays where it is drawn: without SKETCH_ARTWORK a placed print came
back as an all-over pattern. DESIGN_KEPT exists because "real-world proportions" alone was read as
licence to even out a short part under a long one and a one-sided element (both measured on
garments: a short skirt under a long panel, an asymmetric train).

**D-06. Never state an absence.** A `none` read on a sketch is absence of evidence; stated in the
prompt it reads as an order (measured on garments: "details: none" dropped an all-over print).
The prompt no longer carries a sketch reading; the analyser's `parts` and `details` list only what
is drawn, and a line after them keeps every print, logo, graphic or text, listed or not.

**D-07. Image model: GPT Image 2.5 Sunburst through `/v1/images/edits`.** *Why:* the only model
that held the material sample across a ten-garment comparison (10/10 against 5/10 for the
runner-up, which held construction well and ran faster). Bedrock has no multi-reference image model, so the
call leaves AWS; the registry makes that explicit per entry. *Rejected:* single-reference
sketch-control models (no multi-view input, availability limits); smaller open-weight models
(weak on logos).

**D-08. 2336×3504 at `max` by default; 1536×2304 at `high` for iteration.** Largest 2:3 portrait
the API accepts. Inputs and views are never downsampled: tools and agents did it silently and lost
small artwork.

**D-09. Plain `fetch`, no SDK retries.** The provider SDK's default retries stacked on the durable
step's three attempts would turn one throttled image into nine paid calls.

## Specification

**D-10. No defaults; every field supplied or observed.** *Why:* per-category defaults turned a
purple sketch into an ecru dress (measured on garments), and the critic then scored against the
wrong spec. Dimensions are supplied only: a size cannot be measured on a drawing.

**D-11. Product details are free-form and read only by the analyser.** Column names change
between exports and languages, and a designer may only have a line of text
(`Lounge chair, solid walnut frame, cream wool seat, 78 cm wide, 75 cm tall`), so the details are plain text or JSON (pretty-printed when
it parses), no code reads them by key, and the container is validated, not the content. They are
data, never instructions, and nothing is defaulted from them. The wire field keeps the name
`productMetadata`. *Rejected:* a manual metadata form; key mapping; JSON only (a line of text
had to be wrapped in a made-up key); a verbatim check of metadata values in code (the analyser
may legitimately rephrase).

**D-12. The analyser decides what each image is.** The designer uploads one to five images and
tags nothing. The analyser reads each as a `sketch` or a `photo` of the product (the design
references, with the views each shows), a `material` sample, or `ignored`; at least one sketch or
photo, else the run fails at analysis (terminal). The first material is the material sample;
further ones go to the image model after the design references as references only, with a
warning. The critic's sketch is the first sketch, else the first photo. The decision is stored on
the analysis and the spec (`imageKinds`) and shown on every thumbnail. An older client's `swatch`
role is accepted and passed to the analyser as a hint; a run analysed before then falls back to
its roles. *Why:* sketches are not uniform (technical drawings, illustrations in use, several
views on one sheet, detail insets, prototype photos), so a tag per file could describe neither
the views nor every file, and a mistagged swatch silently became a design reference. *Rejected:*
user-tagged roles (a role picker per file, the previous design), per-file view roles. At most five
images: a product choice keeping the largest call (five uploads, two renders) under the 16 images
a GPT Image edit accepts and the 20 of a Converse message.

**D-13. Analysis failure fails the run; malformed answers are retried.** No degraded mode: without
an analysis there is nothing to build a prompt from. Structured output was measured returning
valid JSON missing required keys about one call in five; the next call usually complied.

**D-14. Stage 03 enforces the intersection of model limits** (jpeg/png/webp, ≤ 3.75 MB,
≤ 8000 px), on the stored bytes, HEAD first. An oversized sketch rejected here costs nothing; the
same sketch reaching the critic fails the run after a paid generation.

## Evaluation

**D-15. The critic compares pairwise; code decides.** One call sees the sketch, the generated
view and the material sample together and answers `same`, `different` or `cant_tell` per aspect,
with a one-line reason; code computes the verdict, so a failure still names its aspect.
*Rejected:* reading the sketch and the view separately into a closed vocabulary and comparing the
words in code (D-15 before this one). It failed good images on synonyms (`closure: expected belt,
observed tie` on a tie belt; `drop_shoulder` vs `set_in`), rejected almost every real product
photo, and its garment vocabulary could not describe a
lamp or a bottle. Also rejected: a single call scoring free axes (could not name the wrong
aspect).

**D-16. Fail only on hard facts, confirmed twice.** A view fails on a different object type, a
colour different from the supplied colour or the material sample (never the sketch's drawing
colour), an unusable image, or a requested change confidently not applied. The first three fail
only when a second call, same prompt and images, agrees; every other difference warns, its issue
kept for a retry. *Why:* a false fail buys a paid image regeneration, a confirmation call costs
cents. The second call runs at its own temperature (D-27).

**D-17. Only supplied facts are references.** An observed spec field is the analyser's reading
of the same images the critic looks at.

**D-18. Measure the critic on labelled generated views.** `npm run critic:measure` replays the
critic on stored runs a person labelled good or bad, and reports false fails, false passes and
per-aspect disagreements ([evaluation](../evaluation/README.md)). A judge that rejects everything
catches every negative, so the false-fail rate on good views matters as much as the catch rate.

**D-19. Targeted retries with the critic's issues, at most four.** Only failed views and their
dependants are remade. *Rejected:* rerolls from the same spec (the issues were never used).

**D-20. Never auto-accept; the best attempt goes to a human.** When the budget is spent, the run
parks at review with `approved: false` instead of failing: the reviewer has the last word.

## Review

**D-21. Regeneration from plain words, routed by an LLM, cascaded by code.** The model places
parts on views (a reading of words); `viewsToRemake` applies the dependency rule. A regeneration
is one unscored attempt: the reviewer who wrote the requests judges them. Requests are resent
whenever their view is remade, or the next round would undo them. A garbled triage falls back to
the whole comment for every view rather than failing the run. Capped at three rounds.

**D-22. Owner reviews own run**, confined to one predicate so a separate reviewer population
changes one function.

## Orchestration

**D-23. Lambda durable function.** Hours-to-days human wait at no compute cost
(`waitForCallback`), checkpointed retries per call, idempotent submit via the execution name.
Rules in [03](03-orchestration.md). Enabled at creation, invoked through the `live` alias.

**D-24. Keys, not bytes or URLs, in checkpoints and documents.** Execution storage is capped at
100 MB; presigned URLs expire before a review ends, so they are minted on every read.

**D-25. Every revision has its own key prefix** (`{stamp}-{revisionId}`, derived from the stored
`createdAt`): a fixed prefix let a second approved run overwrite the first delivery.

## Scope

**D-26. Generic only: no domain profiles.** The sample works for any sketched physical object with
a front, a back and sides. The analyser names the object (`productType`, in the designer's words),
its parts and the marks to leave out; those drive the image prompt, the critic and feedback
triage, in object-neutral wording. The fabric swatch became a generic material sample, which the
analyser now identifies (D-12). Removed: the garment groups, the invisible-mannequin and
accessory staging, the fabric-behaviour table, the sketch reading, and the `family` and
`composition` fields (a composition column is joined into the material by the analyser).
*Why:* one code path to test and explain; a category list is never complete. *Rejected:*
per-domain profiles (garments, footwear, furniture), which would bring back keyword routing and
untested branches. *Open:* the generic staging and material guidance are unmeasured on non-garment
products; the earlier garment findings (D-05, D-06, D-07, D-10) may not all carry over.

**D-27. The confirmation call reads at temperature 0.7.** The first comparison keeps the critic
entry's temperature (0); the confirmation call is sent at `CONFIRMATION_TEMPERATURE` 0.7, inside
the 0–1 range Converse accepts
([InferenceConfiguration](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html)).
*Why:* an identical call at temperature 0 mostly repeats the first answer, so it confirms little.
`critic:measure` reports how many confirmation calls overturned a fail. The critic
entries default to 4096 output tokens; the comparison keeps its 3072-token floor.

**D-28. The image prompt names each design reference by its kind.** With sketches only the
wording is unchanged. Photos (of the product, a prototype or a reference) are called the photos of
the product: they decide shape and construction and, unless a material sample or the written
inputs say otherwise, the colour and the material; the drawing rules (exaggerated proportions,
uneven drawn edges, sketch colours as markers) are left out, and anything that is not part of the
product (people, hands, other objects, background) is left out. With both, the sketch decides the
construction, the photos show the real look, and the opening says which attached image is which
([05](05-prompt.md#sketches-photos-or-both)). *Why:* calling a photo "the sketch" told the model to
correct proportions and colours that are already real. *Rejected:* keeping the sketch wording
until photo-only products were measured (was O-9); a separate photo template (two code paths for
the shared rules). *Open:* the photo wording is not yet measured on generated images.

## Security

**D-29. Free text is sanitised everywhere and screened by a Bedrock guardrail.** One pure,
idempotent `sanitizeText` ([02](02-data-contracts.md#free-text-sanitisation)) runs in the web
form, the CLI, the API (before any check) and the pipeline: it removes the characters that hide
or reorder text (controls, format and bidi characters, tag characters, data-carrying variation
selectors) and applies NFKC, so what a reviewer reads is what a model reads. An Amazon Bedrock
guardrail (content filters and prompt-attack detection, text only) then screens every
user-written string at least once before any model sees it
([03](03-orchestration.md#guardrail-screening)): on Bedrock calls through `guardrailConfig` with
only the user text in `guardContent`, so our own prompts are never classified as attacks; on
text bound for the image model, or for a non-Bedrock analyser, with `ApplyGuardrail` first. A
block is terminal and names the field and policy, never the text. A blocked review note is a 400
from the API, before the callback, so a bad note does not fail a run the reviewer wants to
continue. *Why:* the notes and the triage's requests are placed in the image prompt with
authority over the inputs, and fencing and JSON-quoting only frame them as data; a classifier in
front is a second, independent layer. *Rejected:* a hand-written deny list or regex (incomplete,
language-bound); screening only through Converse (the image model and an OpenAI analyser are
outside Bedrock); screening the submit in the API (puts up to 64 KB of screening in the 30 s
request path; the `validate` stage fails the run with the same message on the rail); the
Standard tier (needs a cross-Region guardrail profile, so the text could be processed in other
Regions); High strengths (notes are imperative by nature: more false prompt-attack blocks).
*Residual risk:* text written inside an uploaded image reaches the analyser, the critic and the
image model as pixels and is not screened by a text guardrail; the analyser and critic prompts
treat it as data, and its reading reaches the spec, and then the image prompt, only through the
analysis. The analysis itself is screened on output only on Bedrock. The guardrail's
classifiers can block legitimate product text (a false positive is a failed run to resubmit,
reported by policy). NFKC changes compatibility characters (`²` → `2`). *Open:* false-positive
rates on real product details and notes are unmeasured; strengths are in
`infra/modules/guardrail/main.tf`.

**D-30. The API is served through CloudFront and AWS WAF only.** The HTTP API is a second origin
of the web distribution under `/api/*` (caching disabled, an origin request policy that forwards
`authorization`, `content-type`, `if-none-match`, CORS preflight headers and query strings, no
cookies, no `Host`), so every browser call passes the same web ACL and the SPA is same-origin.
CloudFront adds a Terraform-generated secret header that the API function checks in constant time
before any route; two secret slots let a rotation proceed without refusing traffic. The Common
rule set's 8 KB body rule counts instead of blocking, and a label rule re-blocks it everywhere
but paths starting `/api/revisions` (product details up to 64 KB, notes up to 4,000 characters);
every other managed rule blocks. The per-IP rate limit rises from 500 to 2,000 requests per
5 minutes because polling now counts, and API writes get their own limit of 100. *Why:* an HTTP
API cannot attach AWS WAF, so WAF covered only the SPA (security review, §4c).
*Rejected:* `disable_execute_api_endpoint` (needs an API Gateway custom domain as the origin,
which is itself directly reachable); a Lambda authorizer for the header (a route takes one
authorizer, and the JWT authorizer stays); a REST API with a resource policy and a regional web
ACL (a migration for the same result); the managed `AllViewerExceptHostHeader` policy (forwards
cookies, which disables `If-None-Match` conditional requests); excluding the whole Common rule set
for `/api/*` (drops the XSS, LFI, RFI and SSRF body rules). *Residual risk:* the secret is in the
Terraform state, the function's environment and the distribution configuration; a holder of
`cloudfront:GetDistributionConfig` can read it. Body rules inspect the first 16 KB only. The
distribution has no custom error responses any more, which applied to every origin.

**D-31. Cognito threat protection is enforced.** `ENFORCED` by default (`cognito_threat_protection`;
`AUDIT` and `OFF` remain), which needs the Plus feature plan. Adaptive authentication: no action
at low risk, the TOTP challenge for users who set it up at medium risk, and at high risk the
challenge or a block for users without MFA; compromised credentials block sign-in, password change
and sign-up. *Why:* reviewers' approvals are recorded by name, so account takeover is the risk
that matters (security review). *Rejected:* `BLOCK` at high risk (locks out a reviewer who could
pass MFA); notification e-mails (need an SES identity). *Residual risk:* compromised-credentials
checks do not see SRP sign-ins; MFA stays optional (see
[Recommendations for production](../../README.md#recommendations-for-production) for what this
sample leaves to the deployer). The Plus plan costs more per monthly active user
([pricing](https://aws.amazon.com/cognito/pricing/)).

**D-32. The API reaches user data only through a per-user, session-tagged role.** Every revision
key starts with its owner's Cognito `sub` (`USER#{sub}#REV#{id}`) and every artifact key with
`user/{sub}/`. The API function's own role has no DynamoDB or S3 access; for each request it
assumes `…-api-user-data` with the caller's verified `sub` as the only session tag, and that
role allows DynamoDB only where `dynamodb:LeadingKeys` matches `USER#${aws:PrincipalTag/sub}#*`
and S3 only under `user/${aws:PrincipalTag/sub}/*`. Presigned URLs are signed with those
credentials. *Why:* per-user isolation was enforced only by an ownership check in code, so one
missing check on a new route would have exposed every user's data; now IAM denies a cross-user
read or write even when the code builds the wrong key (security review). This is the
token-vending-machine pattern from AWS SaaS guidance, server-side: the browser never holds AWS
credentials ([session tags](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html),
[DynamoDB fine-grained access control](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)).
The ownership predicates still run, as a second check. Credentials are cached per user for at
most 10 minutes and only while they outlive the longest presigned URL (45 minutes): a URL dies
with the credentials that signed it, and a role assumed by a role lasts at most one hour
([S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html),
[role chaining](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-console.html)).
The status ETag changes every 10 minutes so an idle tab is handed fresh URLs. *Rejected:* a
Cognito identity pool giving the browser AWS credentials (adds credentials to the browser for no
gain); an in-code check only (no backstop). *Breaking:* revisions written before the owner
prefix (and the earlier ownerless ones) are no longer reachable through the API.
*Residual risk:* **the pipeline keeps its service role** with access to the whole table and
bucket: it runs for days after the user's session has ended, and no AWS reference pattern covers
per-user credentials for such a workflow, so it was not built. The pipeline builds every key from
the owner in its payload and refuses an input outside that owner's prefix, but that is a check in
code, not IAM.

## Open questions

| # | Question | Notes |
|---|---|---|
| O-1 | **Confirmation temperature.** 0.7 is a starting value (D-27). | Read the confirmation counts from `critic:measure` before changing it. |
| O-2 | **Image cost at `max`.** No per-image price is published (token-priced). | Read a few runs' spend from the provider dashboard, then decide the default. |
| O-3 | **Input resolution.** Small sketches and thumbnail material samples lose small artwork; the pipeline cannot recover it. | A data question for whoever supplies the inputs. |
| O-4 | **Data residency.** The image call (and an OpenAI or gateway analyser) is processed outside AWS; a gateway's onward processing location is not knowable from the registry. | Get sign-off before sending real designs; regional API hosts need provider approval. |
| O-5 | **Reviewer identity.** Only the JWT `sub` is available; a reviewer group or per-product list is not modelled. | See D-22. |
| O-6 | **`Retry-After`.** Rate-limit responses' `Retry-After` is not read; the step backoff (2 s, 4 s) applies. | |
| O-7 | **Colourways.** Another colourway is another submit reusing the image keys with that colourway's metadata and material sample; there is no batch endpoint and the analysis is not cached across runs. | A UI loop over submit, if wanted. |
| O-8 | **Image classification accuracy.** How often the analyser misreads an image (a coloured sketch as a photo, a close-up of the product as a material) is unmeasured. | Run mixed packages through the CLI with `--fake-images` (the analyser only is paid) and read the labels; a misread shows on the thumbnails and in the warning. |
