/**
 * The durable function that runs every stage of one revision.
 *
 * Two constraints from the durable-execution model shape this whole module:
 *
 *  1. Durable execution cannot be retrofitted. `durable_config` must be present when
 *     the function is created, so flipping it on later means replacing the function.
 *  2. Durable invocations must target a *qualified* ARN. That is why `publish = true`
 *     and a `live` alias exist, and why the alias ARN — not the function ARN — is what
 *     the API is given.
 *
 * The execution outlives any single Lambda invocation: the human review gate parks on a
 * callback wait for up to `review_timeout_days`, which is why `execution_timeout` is measured
 * in days while `timeout` (per-invocation) stays at seconds.
 */

locals {
  review_timeout_seconds = var.review_timeout_days * 24 * 60 * 60
}

# A directory, not a single file: `sharp` cannot be inlined by esbuild, so the handler and
# the vendored linux-arm64 prebuild in `build/node_modules` both have to be in the zip.
# `output_path` stays outside `build/` so the archive never contains a stale copy of itself.
data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = "${path.module}/build"
  output_path = "${path.module}/pipeline.zip"

  # `build/node_modules` is gitignored, so fail at plan time rather than ship a function
  # that dies on its first image read with a module-resolution error.
  lifecycle {
    precondition {
      # Not a fixed filename: sharp's linux-arm64 prebuild names the binary after its own
      # version (e.g. `sharp-linux-arm64-0.35.4.node`), which is pinned once in
      # vendor-sharp.sh, not duplicated here.
      condition     = length(fileset("${path.module}/build/node_modules/@img/sharp-linux-arm64/lib", "*.node")) > 0
      error_message = "Vendored sharp binary missing. Run `npm run bundle:pipeline` before applying."
    }
  }
}

resource "aws_lambda_function" "pipeline" {
  function_name = "${var.name}-pipeline"
  role          = aws_iam_role.pipeline.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]

  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  # Per-invocation ceiling, not per-execution: a replay slice only has to get from one
  # checkpoint to the next, and a slice cut short resumes from the last checkpoint. The whole
  # run is bounded by `durable_config.execution_timeout`. The Lambda maximum, because one
  # invocation holds a whole 2D attempt: the front view call (about 90 s at the registry's
  # default size and quality), then the back and the two profiles together (OpenAI runs two at
  # once and queues the third, about 200 s), each call allowed 300 s by the shared adapter.
  timeout     = 900
  memory_size = 1024
  publish     = true

  tracing_config {
    mode = "Active"
  }

  durable_config {
    # Must cover the whole run including the human-review wait.
    execution_timeout = local.review_timeout_seconds

    # Checkpoint history is the audit trail of what the pipeline decided; keep it as
    # long as the review window so a timed-out run can still be explained.
    retention_period = var.review_timeout_days

    # Checkpoints hold step results (spec, prompts, verdicts): encrypt them with the data key.
    kms_key_arn = var.data_key_arn
  }

  logging_config {
    log_format = "JSON"
    # Not DEBUG: DEBUG logs replay internals on every slice of a function that replays by design.
    application_log_level = "INFO"
    # INFO, not WARN: WARN drops the START and REPORT lines (duration, memory, cold start) of
    # every successful invocation, and a run that fails a stage still ends one successfully.
    system_log_level = "INFO"
    log_group        = aws_cloudwatch_log_group.pipeline.name
  }

  environment {
    variables = {
      TABLE_NAME          = var.table_name
      ARTIFACTS_BUCKET    = var.artifacts_bucket
      IMAGE_MODEL         = var.image_model
      IMAGE_SIZE          = var.image_size
      IMAGE_QUALITY       = var.image_quality
      ANALYSER_MODEL      = var.analyser_model
      EVALUATION_MODEL    = var.evaluation_model
      ATTEMPT_BUDGET      = tostring(var.attempt_budget)
      REVIEW_TIMEOUT_DAYS = tostring(var.review_timeout_days)
      LOG_LEVEL           = "INFO"

      LITELLM_BASE_URL           = var.litellm_base_url
      LITELLM_API_KEY_SECRET_ARN = var.litellm_api_key_secret_arn

      OPENAI_API_KEY_SECRET_ARN = var.openai_api_key_secret_arn
      OPENAI_ORGANIZATION       = var.openai_organization
      OPENAI_PROJECT            = var.openai_project

      GUARDRAIL_ID      = var.guardrail_id
      GUARDRAIL_VERSION = var.guardrail_version
    }
  }

  kms_key_arn = var.data_key_arn

  # Caps concurrent paid model calls and blast radius; -1 leaves the function unreserved.
  reserved_concurrent_executions = var.reserved_concurrency

  # Durable functions support a DLQ but not destinations, and an async execution that ends
  # FAILED, STOPPED or TIMED_OUT is not retried: Lambda sends the triggering event here
  # (https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk-retries.html#durable-invocation-retries).
  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  # Stopping in-flight durable executions and deleting the function can take up to an
  # hour; the provider default would time out first.
  timeouts {
    delete = "60m"
  }

  # The role policy first: Lambda checks sqs:SendMessage on the DLQ when the config is set.
  depends_on = [
    aws_iam_role_policy_attachment.durable,
    aws_iam_role_policy.pipeline,
    aws_cloudwatch_log_group.pipeline,
  ]
}

/**
 * Runs the handler cannot record itself: a stage failure is marked on the revision and the
 * handler returns normally, so only an unhandled error, an execution timeout or a stopped
 * execution lands here, with the submit event for a redrive. SSE-KMS with the data key: the
 * role's DataKey statement already grants the GenerateDataKey and Decrypt a producer needs
 * (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-key-management.html).
 */
resource "aws_sqs_queue" "dlq" {
  name                              = "${var.name}-pipeline-dlq"
  kms_master_key_id                 = var.data_key_arn
  kms_data_key_reuse_period_seconds = 300
  message_retention_seconds         = 1209600 # 14 days
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.pipeline.function_name
  function_version = aws_lambda_function.pipeline.version
}

# Declared explicitly rather than left to Lambda's implicit creation, so retention and
# the CMK are under Terraform's control from the first invocation.
resource "aws_cloudwatch_log_group" "pipeline" {
  name              = "/aws/lambda/${var.name}-pipeline"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_key_arn
}

resource "aws_iam_role" "pipeline" {
  name               = "${var.name}-pipeline"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_partition" "current" {}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Required: without it the function's own checkpoint reads and writes fail.
resource "aws_iam_role_policy_attachment" "durable" {
  role       = aws_iam_role.pipeline.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "pipeline_xray" {
  role       = aws_iam_role.pipeline.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "pipeline" {
  name   = "pipeline"
  role   = aws_iam_role.pipeline.id
  policy = data.aws_iam_policy_document.pipeline.json
}

data "aws_iam_policy_document" "pipeline" {
  # Only the one secret holding the LiteLLM key, and only when one is configured.
  dynamic "statement" {
    for_each = var.litellm_api_key_secret_arn == "" ? [] : [var.litellm_api_key_secret_arn]
    content {
      sid       = "LiteLLMKey"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [statement.value]
    }
  }
  # Likewise the one secret holding the OpenAI project key, only when one is configured.
  dynamic "statement" {
    for_each = var.openai_api_key_secret_arn == "" ? [] : [var.openai_api_key_secret_arn]
    content {
      sid       = "OpenAIKey"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [statement.value]
    }
  }
  statement {
    sid    = "Logs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # Already scoped to one specific log group; the trailing `:*` is AWS's own required
    # pattern for log-stream-level actions (stream names are runtime-generated and cannot
    # be enumerated ahead of time) — this is the same shape as the AWS-managed
    # AWSLambdaBasicExecutionRole policy, which wildcards the entire logs service.
    #tfsec:ignore:aws-iam-no-policy-wildcards
    resources = ["${aws_cloudwatch_log_group.pipeline.arn}:*"]
  }

  statement {
    sid    = "StageEventLog"
    effect = "Allow"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]

    resources = [var.table_arn]
  }

  statement {
    sid       = "Artifacts"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.artifacts_arn}/*"]
  }

  statement {
    sid       = "ArtifactsList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.artifacts_arn]
  }

  statement {
    sid       = "Dlq"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }

  statement {
    sid    = "DataKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]

    resources = [var.data_key_arn]
  }

  # Region is wildcarded: a geo inference profile (`us.*`) routes each call to any Region it
  # covers, so the foundation-model ARN can be in a Region other than the stack's.
  #
  # A global profile (the Bedrock analyser) is also authorized against the Region-less
  # foundation-model ARN, which the Region wildcard does not match
  # (https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html),
  # and GPT-5.6 Luna also needs the account's default project
  # (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html).
  statement {
    sid    = "Bedrock"
    effect = "Allow"

    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]

    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
      "arn:${data.aws_partition.current.partition}:bedrock:*:${var.account_id}:inference-profile/*",
      "arn:${data.aws_partition.current.partition}:bedrock:::foundation-model/*",
      "arn:${data.aws_partition.current.partition}:bedrock:*:${var.account_id}:project/default",
    ]
  }
  # Converse with guardrailConfig and ApplyGuardrail both need this, on the guardrail only
  # (https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions.html). Its
  # data-key Decrypt is the DataKey statement above.
  dynamic "statement" {
    for_each = var.guardrail_arn == "" ? [] : [var.guardrail_arn]
    content {
      sid       = "Guardrail"
      effect    = "Allow"
      actions   = ["bedrock:ApplyGuardrail"]
      resources = [statement.value]
    }
  }
}
