# 11. Infrastructure

Reference implementation: Terraform in `infra/` (modules `security`, `guardrail`, `storage`,
`auth`, `pipeline`, `api`, `web`; root `envs/dev`), AWS provider `~> 6.65` (6.25.0 is the first to expose
`durable_config`). Any IaC tool works; the properties below are the requirements.

## Region and model placement

- Everything in **us-east-1** (the root module validates it). The CloudFront-scoped WAF web ACL,
  its log group and its KMS key are created through a us-east-1 provider alias in any case, since
  CloudFront-scoped resources must be there.
- Bedrock models are called through **US geo cross-Region inference profiles** (`us.` prefix)
  entered from us-east-1; requests may be served in any Region of the profile, which the registry
  records as residency. IAM must therefore allow the foundation-model ARN in every Region
  ([cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)).
- The image model (and an OpenAI or gateway analyser) is outside AWS: the function reaches
  `api.openai.com` (or the gateway) over the default internet egress (no VPC). Sending real,
  pre-release designs to a third-party API is a data-handling decision for the design owner;
  OpenAI's own retention terms apply
  ([your data](https://developers.openai.com/api/docs/guides/your-data)).

## Resources

| Resource | Configuration | Why |
|---|---|---|
| KMS key `data` | rotation on, 7-day deletion window; key policy: account root, plus `lambda.amazonaws.com` `GenerateDataKey`/`Decrypt` conditioned on `aws:SourceAccount`, `aws:SourceArn` and `kms:EncryptionContext:aws:lambda:FunctionArn` = the pipeline function | encrypts the table, the artifacts bucket, the DLQ, both functions' environment variables and the durable execution state ([durable encryption](https://docs.aws.amazon.com/lambda/latest/dg/durable-encryption.html)) |
| KMS key `logs` | key policy grants `logs.{region}.amazonaws.com` with an `aws:logs:arn` encryption-context condition | log groups need a different key policy; keeps that grant off product data |
| Artifacts bucket | private (all public access blocked), SSE-KMS with bucket key, versioning, TLS-only policy, access logs to the logs bucket, noncurrent versions expire after 30 days, incomplete multipart uploads after 7 | every input, candidate and delivery; only presigned URLs reach a browser |
| Artifacts bucket CORS | `GET`, `PUT`, `HEAD` from the allowed web origins and the CloudFront domain; expose `ETag` | browser PUT of uploads, display of presigned GETs |
| Logs bucket | private, SSE-S3 (required for S3 server access logs), ACLs disabled, versioning, TLS-only, a bucket policy admitting `logging.s3.amazonaws.com` and `delivery.logs.amazonaws.com` for this account, expire after 90 days | S3 server access logs and CloudFront logging v2 |
| DynamoDB table | on-demand, `pk`/`sk` strings, SSE-KMS (data key), point-in-time recovery, optional deletion protection | revisions and their event log in one partition ([02](02-data-contracts.md#revision-store-layout-key-value-table)) |
| Cognito user pool | admin-created users only, email as username, required `name` attribute, password ≥ 12 with all classes, optional TOTP MFA, hosted UI domain; threat protection `cognito_threat_protection` (default `ENFORCED`, Plus feature plan; `OFF` → Essentials); risk configuration when enforced: low risk no action, medium `MFA_IF_CONFIGURED`, high `MFA_REQUIRED`, no notifications; compromised credentials `BLOCK` on sign-in, password change and sign-up | every reviewer is a named account; the approval records `name`; account-takeover protection ([threat protection](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html)) |
| Cognito app client | public (no secret), code flow only with PKCE, scopes `openid email profile`, callback/logout URLs = allowed origins, SRP and refresh flows, id/access token 60 min, refresh 8 h, token revocation, prevent user-existence errors | SPA sign-in |
| Pipeline function | `nodejs24.x`, arm64, 1024 MB, **timeout 900 s**, `publish = true`, alias **`live`**, X-Ray active, JSON logs at INFO (application and system), explicit log group (KMS `logs`, retention), env encrypted with the data key; **`durable_config { execution_timeout = review_timeout_days × 86400 s; retention_period = review_timeout_days; kms_key_arn = data key }`** set **at creation**; delete timeout 60 min | see below |
| Pipeline DLQ | SQS, SSE-KMS (data key), 14-day retention; `dead_letter_config` on the pipeline function; role `sqs:SendMessage` on it | durable functions support a DLQ but not destinations, and a failed async execution is not retried ([retries](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html#durable-invocation-retries)); the handler records stage failures itself, so the queue gets unhandled errors, timeouts and stopped executions |
| Pipeline package | handler bundle plus the image library's linux-arm64 native binary in the same zip; plan fails if the binary is missing | upload validation and the critic's image preparation decode images natively |
| API function | `nodejs24.x`, arm64, 512 MB, timeout 30 s, X-Ray, JSON logs, explicit log group, SQS DLQ (KMS, 14-day retention) | thin; a failed async event is kept for redrive |
| HTTP API | 6 enumerated routes, all with the JWT authorizer (issuer = user pool, audience = app client); Lambda proxy integration, payload format 2.0, 30 s; the function refuses requests without the CloudFront origin secret (two `random_password` slots in its environment); CORS origins = `allowed_web_origins` only (cross-origin callers such as the local dev SPA; the site is same-origin), methods `GET POST OPTIONS`, headers `authorization content-type if-none-match`, expose `etag`, no credentials, max-age 300; default stage throttling burst 20, rate 10; JSON access logs (request id, IP, route, status, length, integration error, time) | |
| Web hosting | private S3 bucket behind CloudFront with Origin Access Control; second origin = the HTTP API (`https-only`, TLS 1.2, 30 s read timeout, `x-origin-verify` custom header) on behaviour `/api/*`: all methods, `Managed-CachingDisabled`, origin request policy forwarding `authorization`, `content-type`, `if-none-match`, `origin`, the CORS preflight headers and all query strings, no cookies, no `Host`; no custom error responses (they would rewrite the API's 403/404); bucket policy limited to that distribution, viewer TLS 1.2 minimum only with a custom domain and an ACM certificate (`web_domain_name`, `web_acm_certificate_arn`; the default `*.cloudfront.net` certificate always uses the TLSv1 policy), HTTP/2 and 3, access logs | SPA and the only public path of the API |
| Response headers | CSP `default-src 'self'`, `img-src` and `connect-src` include the artifacts bucket origin, `connect-src` `'self'` (the API) and the Cognito domains; HSTS 1 year; `X-Frame-Options DENY`; nosniff; strict-origin-when-cross-origin | |
| Bedrock guardrail (when `guardrail_enabled`) | `aws_bedrock_guardrail`: content filters `HATE`, `INSULTS`, `SEXUAL`, `VIOLENCE`, `MISCONDUCT` at `MEDIUM` on input and output, `PROMPT_ATTACK` at `MEDIUM` on input with output strength `NONE`; text modality, action `BLOCK`; Classic tier; blocked-input and blocked-output messages; `kms_key_arn` = data key. `aws_bedrock_guardrail_version` (kept on destroy, replaced when the guardrail changes) | screens every free-text input ([03](03-orchestration.md#guardrail-screening)); a pinned version so an edit reaches running functions only through a new version |
| WAF (CloudFront scope) | AWS managed Common rule set with `SizeRestrictions_BODY` overridden to count, a rule blocking on its label outside paths starting `/api/revisions`; Known Bad Inputs; rate limits per IP over 5 min: 2,000 requests, 100 `POST /api/*` (block); request logs to `aws-waf-logs-…` with the `authorization` header redacted, KMS key in us-east-1 | protects the SPA and the API; the 8 KB body rule would block product details (up to 64 KB) and long notes, so it is lifted for submit and review only ([10](10-api-and-ui.md#api)) |

### Why the pipeline function is shaped this way

- **Durable execution cannot be retrofitted**: it is enabled only when the function is created
  ([configure durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-configuration.html)).
- **Invoke a qualified ARN.** Durable functions reject unqualified invocations; an execution is
  pinned to the version that started it
  ([qualified ARNs](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html)). The API
  invokes `…:function:{name}-pipeline:live`.
- **Execution timeout covers the human wait** (days); the per-invocation timeout only covers one
  replay slice between checkpoints, which must hold the longest step (a profile pair, ~200 s, each
  call allowed 300 s), hence 900 s.
- **Retention = review window**, so a timed-out run can still be explained from its history
  (1–90 days allowed).
- **INFO, not DEBUG**: debug output can expose step results and replay internals on every slice.

## IAM (least privilege)

Pipeline role:

| Statement | Actions | Resources |
|---|---|---|
| managed | `AWSLambdaBasicDurableExecutionRolePolicy` (checkpoint read/write), `AWSXRayDaemonWriteAccess` | |
| Logs | `logs:CreateLogStream`, `logs:PutLogEvents` | its own log group `:*` |
| Store | `dynamodb:GetItem`, `Query`, `PutItem`, `UpdateItem` | the table |
| Artifacts | `s3:GetObject`, `s3:PutObject` on `bucket/*`; `s3:ListBucket` on the bucket (a missing key then reads as 404, not 403) | artifacts bucket |
| Data key | `kms:Decrypt`, `GenerateDataKey`, `DescribeKey` | data key |
| Bedrock | `bedrock:InvokeModel`, `InvokeModelWithResponseStream` | `arn:aws:bedrock:*::foundation-model/*`, `arn:aws:bedrock:*:{account}:inference-profile/*`, the Region-less `arn:aws:bedrock:::foundation-model/*` (global profiles), `arn:aws:bedrock:*:{account}:project/default` (required by one shipped analyser) |
| Provider key | read of the secret value | only the configured OpenAI and/or gateway key secret; no statement when unset |
| Guardrail | `bedrock:ApplyGuardrail` | the guardrail ARN; no statement when disabled. Needed for Converse with `guardrailConfig` as well as for `ApplyGuardrail` ([guardrail permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions.html)); the guardrail's data-key `kms:Decrypt` is the Data key statement |

API role: own logs; **no DynamoDB or S3 access**; `sts:AssumeRole` and `sts:TagSession` on the
user-data role only; data key (environment variables, DLQ); `lambda:InvokeFunction` on the **alias ARN only**;
`lambda:SendDurableExecutionCallbackSuccess`, `…Failure`, `…Heartbeat` on the unqualified
function ARN and `:*` (a parked execution may run on an older version than `live`);
`sqs:SendMessage` on its DLQ; X-Ray; `bedrock:ApplyGuardrail` on the guardrail ARN when enabled (it
screens review notes).

User-data role (`…-api-user-data`), assumed by the API per request with the caller's `sub` as the
only session tag ([D-32](13-decisions.md)):

| Statement | Actions | Resources and conditions |
|---|---|---|
| Trust | `sts:AssumeRole`, `sts:TagSession` | principal: the API role only; `aws:RequestTag/sub` present and non-empty; `aws:TagKeys` only `sub` |
| OwnRevisions | `dynamodb:GetItem`, `Query`, `PutItem`, `UpdateItem` | the table, where every `dynamodb:LeadingKeys` matches `USER#${aws:PrincipalTag/sub}#*`, and `dynamodb:LeadingKeys` is present (no Scan) |
| OwnArtifacts | `s3:GetObject`, `s3:PutObject` | `bucket/user/${aws:PrincipalTag/sub}/*` |
| Data key | `kms:Decrypt`, `GenerateDataKey`, `DescribeKey` | data key |

`max_session_duration` is one hour, the cap for a role assumed by a role. The function runs with
`STORE_REQUIRES_USER_SCOPE=true`: a store call outside a user scope throws rather than use the
function's own credentials.

The guardrail is encrypted with the data key, whose key policy delegates to IAM through the
account statement: the identity that creates the guardrail needs `kms:Decrypt`,
`kms:GenerateDataKey`, `kms:DescribeKey` and `kms:CreateGrant` on it, and a role that uses the
guardrail needs `kms:Decrypt`
([guardrail KMS key](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-kms.html)).

Provider keys live in AWS Secrets Manager, created **outside** the IaC so they never land in
state; the secret holds the bare key or `{"apiKey": "…"}`.

## Configuration

| Variable (IaC) | Env var | Function | Default | Meaning |
|---|---|---|---|---|
| `image_model` | `IMAGE_MODEL` | both | registry default | default image model for a run that names none |
| `image_size`, `image_quality` | `IMAGE_SIZE`, `IMAGE_QUALITY` | both | registry defaults | must be options of the image entry; a run's settings take precedence |
| `analyser_model` | `ANALYSER_MODEL` | pipeline | registry default | analyser and triage model; checked at cold start |
| `evaluation_model` | `EVALUATION_MODEL` | pipeline | `critic-sonnet` | critic; checked at cold start |
| `attempt_budget` (1–10) | `ATTEMPT_BUDGET` | both | 2 | generation attempts before review |
| `review_timeout_days` (1–90) | `REVIEW_TIMEOUT_DAYS` | pipeline | 7 | callback wait, execution timeout, retention |
| `litellm_base_url`, `litellm_api_key_secret_arn` | `LITELLM_BASE_URL`, `LITELLM_API_KEY_SECRET_ARN` | pipeline | placeholder host, empty | gateway provider |
| `openai_api_key_secret_arn`, `openai_organization`, `openai_project` | `OPENAI_API_KEY_SECRET_ARN`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT` | pipeline | empty | OpenAI provider and optional headers |
| `allowed_web_origins` | — | API CORS, Cognito, bucket CORS | local dev origins | |
| `cognito_threat_protection` | — | user pool | `ENFORCED` | `ENFORCED`, `AUDIT` (Plus plan) or `OFF` (Essentials) |
| `origin_secret_slot` | `ORIGIN_VERIFY_SECRETS` | API | `a` | slot CloudFront sends; the function gets both slots, comma-separated |
| `log_retention_days` | — | all log groups | 365 | |
| `api_reserved_concurrency`, `pipeline_reserved_concurrency` | — | the two functions | 20, 10 | `-1` for unreserved |
| `guardrail_enabled` | `GUARDRAIL_ID`, `GUARDRAIL_VERSION` | both | true | create the guardrail and pass its id and published version; false → both empty, screening off, one cold-start warning; an id without a version fails the cold start. The guardrail must be in the Region of the Bedrock calls (us-east-1). |
| — | `TABLE_NAME`, `ARTIFACTS_BUCKET` | both | | |
| — | `PIPELINE_ALIAS_ARN` | API | | qualified pipeline ARN |
| — | `IMAGE_CALL_TIMEOUT_MS` | pipeline | 300000 | per image call |
| — | `LOG_LEVEL` | both | `INFO` | |
| — | `OPENAI_API_KEY`, `LITELLM_API_KEY`, `OPENAI_BASE_URL` | local only | | direct key / host override for local runs and tests |

The API is given the pipeline's ARNs by naming convention (`{name}-pipeline`, alias `live`) so
that targeted plans of the API do not drag the pipeline in; a plan-time check asserts the
convention matches the real function.

## Deployment

Bundle both functions (the pipeline with its native image binary), plan, review, apply (the
reference `deploy.sh` stops for confirmation). Before the first run: create the provider key
secret and check model access from the account and Region. After a change that alters step names or stored shapes,
stop in-flight executions: they replay against the code version they started on.
