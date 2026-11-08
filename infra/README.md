# 2D infrastructure

Terraform for the 2D pipeline: the durable pipeline function, the HTTP API, storage, auth and
the web UI hosting. Everything is in **us-east-1**; `variables.tf` rejects any other Region
because the registry's Bedrock entries are US inference profiles.

```text
envs/
  dev/           root module, example tfvars, backend example
modules/
  security/      KMS keys (data, logs, WAF logs), CloudFront-scoped AWS WAF web ACL and its logs
  guardrail/     Amazon Bedrock guardrail for free-text inputs and its published version
  storage/       artifacts bucket, access-log bucket, DynamoDB table
  auth/          Cognito user pool (threat protection), hosted UI domain, web app client
  pipeline/      the durable Lambda function, its `live` alias, role, log group and DLQ
  api/           HTTP API, JWT authorizer, API Lambda function, DLQ, origin secret
  web/           private S3 bucket with its own KMS key + CloudFront (Origin Access Control,
                 security headers, WAF, the API under /api/*, logging v2), and the artifacts
                 bucket's CORS
```

## Before you start

- Terraform 1.9 or later; the AWS provider is pinned to `~> 6.65` (6.25.0 is the first version
  with `durable_config` on `aws_lambda_function`).
- Node.js 24 and npm, AWS CLI v2, credentials for the target account.
- Bedrock model access for the analyser and critic entries you choose. Run
  `npm run models:check` with the target account's credentials.
- An S3 bucket for the state (and a KMS key, if the state uses one).
- The OpenAI API key in Secrets Manager (see [Secrets](#secrets)).

## Deploy

```bash
make config CONFIG=dev    # copies the examples to dev.tfvars and backend/dev.s3.tfbackend
# edit both, then:
AWS_PROFILE=... make deploy CONFIG=dev
```

`make plan` and `make deploy` run `deploy.sh` (below); call it directly for its
other options.

`deploy.sh <config> [options] [-- <terraform plan args>]` picks `<config>.tfvars` and
`backend/<config>.s3.tfbackend` (both git-ignored). It:

1. prints the account it is about to change;
2. bundles the API and pipeline functions (`npm run bundle:api`, `npm run bundle:pipeline`);
3. runs `terraform init -reconfigure` and `terraform plan`;
4. asks for confirmation, then applies that plan (no changes: skips the apply);
5. builds the web UI with the Cognito outputs (the API is same-origin, `VITE_API_URL` empty),
   syncs it to the web bucket and invalidates the CloudFront distribution.

| Option | Effect |
| --- | --- |
| `--config-dir DIR` | Read `DIR/<config>.tfvars` and `DIR/<config>.s3.tfbackend`, to keep account details out of the repo (`infra/envs/*/local/` is git-ignored). |
| `--plan-only` | Stop after the plan. Nothing is applied or published. |
| `--yes` | Apply without the prompt. Required when there is no terminal. |
| `-- ...` | Extra `terraform plan` arguments, e.g. `-- -var 'image_quality=high'`. |

Terraform zips each module's `build/` directory, so bundling must run before an apply.
`bundle:pipeline` also vendors sharp's linux-arm64 binary; a `precondition` fails the plan if it
is missing.

By hand, the same steps are:

```bash
npm run bundle:api && npm run bundle:pipeline
cd infra/envs/dev
terraform init -reconfigure -backend-config=backend/dev.s3.tfbackend
terraform plan -var-file=dev.tfvars -out=plan.out
terraform apply plan.out
```

### State backend

`backend.tf` is a
[partial configuration](https://developer.hashicorp.com/terraform/language/backend#partial-configuration):
the state bucket and KMS key come from `backend/<config>.s3.tfbackend`. The bucket must exist
before `terraform init`. `-reconfigure` stops Terraform from offering to copy one account's
state into another when you switch accounts in one checkout.

### Variables

The two example files differ only in providers:

| Variable | `openai-direct.example.tfvars` | `litellm-gateway.example.tfvars` |
| --- | --- | --- |
| `analyser_model` | `analyser-luna-openai` | `analyser-sonnet-bedrock` |
| `image_model` | `gpt-image-flare-openai` | `gpt-image-flare` |
| `evaluation_model` | `critic-sonnet` | `critic-sonnet` |
| secret | `openai_api_key_secret_arn` | `litellm_api_key_secret_arn` |

Leave a model variable empty to use the registry default (`isDefault: true`):
`gpt-image-2.6-sunburst-openai`, `analyser-sonnet-bedrock`, `critic-sonnet`. The model variables name
**registry ids** (`shared/src/registry/models/*.yaml`), not Bedrock model ids. The entry's
`provider` (`bedrock`, `openai` or `litellm`) decides the transport and the permission the call
needs. An unknown id, or one of the wrong category, fails the function's cold start. A registry
test checks that every `*.tfvars` here names valid entries.

Other variables: `image_size`, `image_quality` (registry defaults `2336x3504`, `max`; a value the
entry does not list fails generation), `attempt_budget` (1 to 10, default 2),
`review_timeout_days` (1 to 90, default 7; it also sets the durable execution timeout and
retention), `allowed_web_origins`, `log_retention_days`, `cognito_threat_protection` (see
[Cognito](#cognito)), `origin_secret_slot` (see [The web module](#the-web-module)), `openai_organization`,
`openai_project`, `litellm_base_url`, `guardrail_enabled` (default `true`, see
[Guardrail](#guardrail)), `web_domain_name` and `web_acm_certificate_arn` (see
[The web module](#the-web-module)). See [`envs/dev/variables.tf`](envs/dev/variables.tf).

Switch one model on an existing deployment with a `-var`, e.g.
`./deploy.sh dev -- -var 'image_model=gpt-image-flare-openai'`. A model that has no
registry entry yet needs a new YAML file that passes `shared/src/registry/schema.ts`.

### Secrets

Create the secret outside Terraform, so the key never lands in the state, and without putting
it on the command line (shell history): see the snippet under
[Prerequisites](../README.md#prerequisites) in the main README.

The secret holds the bare key or JSON with an `apiKey` field. Put its ARN in
`openai_api_key_secret_arn`. The pipeline role then gets `secretsmanager:GetSecretValue` on that
one secret; the API function never calls a model (it only screens review notes with the
guardrail). Leaving a secret variable empty grants nothing. The Lambda functions run
outside a VPC and reach `api.openai.com` over the default internet egress.

## Outputs

| Output | Use |
| --- | --- |
| `web_url` | The web UI on CloudFront. |
| `api_url` | The public API path: the site origin + `/api`, through CloudFront and AWS WAF. |
| `api_endpoint` | The raw `execute-api` endpoint, CloudFront's origin. It answers 403 without the origin secret; for operators checking the bypass protection. |
| `pipeline_dlq_url` | The pipeline's dead-letter queue (see [Durable function notes](#durable-function-notes)). |
| `hosted_ui_url`, `user_pool_id`, `user_pool_client_id` | Cognito (`VITE_COGNITO_URL`, `VITE_COGNITO_CLIENT_ID`). |
| `web_bucket`, `web_distribution_id` | Where `deploy.sh` publishes the web UI. |
| `artifacts_bucket`, `table_name` | Inputs, candidates and deliveries; revisions and stage events. |
| `pipeline_alias_arn` | Qualified ARN of the durable function (`<name>-pipeline:live`). |
| `guardrail_id`, `guardrail_version` | The guardrail both functions use (empty when disabled); set them as `GUARDRAIL_ID` and `GUARDRAIL_VERSION` for a local CLI run. |

Create users with `aws cognito-idp admin-create-user`; self sign-up is off.

## Cognito

`cognito_threat_protection` (default `ENFORCED`) sets the user pool's threat protection
([Cognito docs](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html)):

- `ENFORCED`: adaptive authentication with no action at low risk, the TOTP challenge for users
  who set it up at medium risk, and at high risk the challenge or a block for users without MFA;
  compromised-credentials detection blocks sign-in, password change and sign-up with a breached
  password (the user is set to `RESET_REQUIRED`). It cannot check SRP sign-ins. No notification
  e-mails, which would need an Amazon SES identity.
- `AUDIT`: risk is scored and logged, nothing is blocked. Cognito recommends two weeks in audit
  before full function.
- `OFF`: no threat protection.

`AUDIT` and `ENFORCED` need the **Plus** feature plan (`user_pool_tier = "PLUS"`), which is
billed per monthly active user at a higher rate than Essentials; `OFF` sets Essentials. See
[Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) and
[feature plans](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html).

## Guardrail

`modules/guardrail` (created when `guardrail_enabled = true`) is one
[`aws_bedrock_guardrail`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrock_guardrail)
and a published
[`aws_bedrock_guardrail_version`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrock_guardrail_version):

- content filters `HATE`, `INSULTS`, `SEXUAL`, `VIOLENCE`, `MISCONDUCT` at `MEDIUM` on input
  and output, text only, action `BLOCK`;
- `PROMPT_ATTACK` at `MEDIUM` on input; its output strength is `NONE`, since the filter applies
  to prompts only
  ([prompt attacks](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-prompt-attack.html));
- Classic tier (the Standard tier needs a cross-Region guardrail profile);
- encrypted with the data key (`kms_key_arn`). The key policy's account statement delegates to
  IAM, so the identity running Terraform needs `kms:Decrypt`, `kms:GenerateDataKey`,
  `kms:DescribeKey` and `kms:CreateGrant` on the key, and the function roles need `kms:Decrypt`,
  which their `DataKey` statements already grant
  ([guardrail KMS permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-kms.html)).

Both functions get `GUARDRAIL_ID` and `GUARDRAIL_VERSION`, and their roles
`bedrock:ApplyGuardrail` on the guardrail ARN only, which Converse with `guardrailConfig` and
`ApplyGuardrail` both need
([guardrail permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions.html)).
A change to the guardrail publishes a new version on the next apply (old versions are kept for
runs in flight). Tune the strengths in `modules/guardrail/main.tf` if legitimate product text is
blocked; with `guardrail_enabled = false` the variables are empty, nothing is granted, and the
functions log one line saying screening is off.

## The web module

`modules/web` hosts the SPA in a private, versioned S3 bucket served by CloudFront through
Origin Access Control, with the CloudFront-scoped WAF web ACL from `modules/security`. A
response headers policy sets the Content Security Policy and other security headers. The SPA
reads images from the artifacts bucket with presigned URLs, so the module also owns the
artifacts bucket's CORS rules. The CloudFront origin is added to the Cognito callback lists
automatically.

**The API under `/api/*`.** The HTTP API is a second origin of the same distribution, so every
API call passes the WAF web ACL and the SPA calls it same-origin (no CORS, `connect-src 'self'`).
The `/api/*` behaviour allows all methods (CloudFront offers only GET/HEAD, GET/HEAD/OPTIONS or
all seven; unrouted methods are a 404 from API Gateway), uses the managed `CachingDisabled`
policy, and an origin request policy that forwards `authorization`, `content-type`,
`if-none-match`, `origin` and the CORS preflight headers plus all query strings, and no cookies.
`Authorization` must be listed: CloudFront strips it from GET and HEAD otherwise
([CloudFront docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html#add-origin-custom-headers-forward-authorization)).
`Host` is not forwarded, so API Gateway receives its own host name. The managed
`AllViewerExceptHostHeader` policy was not used because it forwards cookies, and CloudFront does
not support `If-None-Match` conditional requests when cookies are forwarded
([CloudFront docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html#RequestCustomConditionalGETs)).
The distribution has no custom error responses any more: they apply to every origin and would
turn the API's 403 and 404 into the SPA shell (runs live at `#/r/{id}`, so only `/` and
`/assets/*` reach S3).

**Bypass protection.** CloudFront adds an `x-origin-verify` origin custom header
([docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html)),
overwriting any value a viewer sends. The API function rejects a request without a matching
value with a 403 before any route runs (`api/src/origin.ts`, constant-time compare; no secret
configured rejects everything). The value is a Terraform `random_password`: it is in the state
(keep the state bucket encrypted and restricted), in the function's environment (encrypted with
the data key) and in the distribution's configuration (readable with
`cloudfront:GetDistributionConfig`). The JWT authorizer still runs first, so a direct call
without a token is a 401 from API Gateway and never invokes the function. *Trade-off:* an HTTP
API has no resource policy and no AWS WAF association, so the check lives in the function. The
alternatives were rejected: `disable_execute_api_endpoint` needs an API Gateway custom domain as
CloudFront's origin, and that domain is as directly reachable as the default endpoint
([API Gateway docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-disable-default-endpoint.html));
a REST API would allow a resource policy and a regional WAF but means migrating the API.

**Rotating the origin secret.** There are two slots, `a` and `b`; CloudFront sends
`origin_secret_slot` and the function accepts both, so a rotation never refuses traffic while
the distribution deploys:

```bash
# 1. new value in the idle slot, and CloudFront switches to it (here a -> b)
./deploy.sh dev -- -replace='module.api.random_password.origin_verify["b"]' -var origin_secret_slot=b
# 2. once the distribution is Deployed, retire the old value
./deploy.sh dev -- -replace='module.api.random_password.origin_verify["a"]' -var origin_secret_slot=b
```

Keep `origin_secret_slot = "b"` in the tfvars afterwards.

**AWS WAF and the API.** The web ACL (`modules/security`) applies to the SPA and the API:

| Rule | Action | Why |
| --- | --- | --- |
| `AWSManagedRulesCommonRuleSet` | block, except `SizeRestrictions_BODY` set to count | Its 8 KB body limit ([rule list](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html#aws-managed-rule-groups-baseline-crs)) would block product details (up to 64 KB) and long review notes. |
| `BodySizeOutsideRevisions` | block | Blocks on that rule's label unless the path starts with `/api/revisions` (submit and review), so the 8 KB limit still holds everywhere else ([label exception pattern](https://docs.aws.amazon.com/waf/latest/developerguide/waf-bot-control-example-user-agent-exception.html)). |
| `AWSManagedRulesKnownBadInputsRuleSet` | block | Unchanged. |
| `RateLimit` | block over 2,000 requests per IP in 5 minutes | Was 500; API polling (about one request a second per open run page) now counts. |
| `RateLimitApiWrites` | block over 100 `POST /api/*` per IP in 5 minutes | Writes start paid image generation. |

The body rules inspect the first 16 KB, CloudFront's default body inspection limit. Every other
Common rule (cross-site scripting, LFI, RFI, SSRF in the body) keeps blocking; a false positive on
legitimate product text shows in the WAF logs with its rule label, and is fixed the same way
(override to count, then block on the label outside the affected path). API Gateway access logs
now record CloudFront's address as `ip`; the client address is in the WAF logs.

**TLS.** With the default `*.cloudfront.net` certificate CloudFront always uses the `TLSv1`
security policy
([CloudFront docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html)).
For a TLS 1.2 minimum, set `web_domain_name` and `web_acm_certificate_arn` (an ACM certificate in
us-east-1 covering the domain): the distribution then uses SNI with `TLSv1.2_2021`, and the
domain replaces the CloudFront one in `web_url`, CORS and the Cognito callbacks. Create the DNS
record (an alias to the distribution) yourself.

## Durable function notes

- Durable execution can only be enabled when a function is created. `durable_config` is set on
  the pipeline function from the start
  ([Configure durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-configuration.html)).
- Durable functions must be invoked with a qualified identifier. The module publishes a version
  and a `live` alias; the API invokes the alias
  ([Invoking durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html)).
- Durable functions support a dead-letter queue but not destinations, and an asynchronous
  execution that ends `FAILED`, `STOPPED` or `TIMED_OUT` is not retried
  ([retries](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html#durable-invocation-retries)).
  The pipeline has an SQS dead-letter queue (data key, 14 days, output `pipeline_dlq_url`). The
  handler records a failed stage on the revision and returns normally, so the queue receives
  only what it cannot handle: unhandled errors, execution timeouts and stopped executions.
- The per-invocation timeout is the Lambda maximum (900 s), because one invocation can hold a
  front view call and then the back and profile calls. The whole run is bounded by
  `review_timeout_days`.

More in [durable-pipeline-design.md](../docs/architecture/durable-pipeline-design.md).

## Destroy

The buckets are versioned and have no `force_destroy`, so empty them first, including object
versions and delete markers (artifacts, web and access-log buckets). Then run
`make destroy CONFIG=dev`.

Deleting the pipeline function can take up to an hour while Lambda stops in-flight executions
(the module allows 60 minutes). KMS keys enter a 7-day pending deletion. The Secrets Manager
secret and the state bucket are not managed here; delete them yourself.
