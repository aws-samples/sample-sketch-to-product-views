/**
 * HTTP API in front of one thin Lambda. Four responsibilities only: presign uploads,
 * submit a revision (which starts the durable execution), read projected state, and
 * resolve the human review gate.
 *
 * The API never computes stage status. It reads the append-only event log the pipeline
 * writes, so a bug here cannot invent progress that never happened.
 */

# Zips whatever `npm run bundle:api` last wrote, so `source_code_hash` alone drives redeploys.
data "archive_file" "bundle" {
  type        = "zip"
  source_file = "${path.module}/build/index.mjs"
  output_path = "${path.module}/build/api.zip"
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name}-api"
  role          = aws_iam_role.api.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]

  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  # Every route returns in well under a second; the headroom covers cold starts.
  timeout     = 30
  memory_size = 512

  tracing_config {
    mode = "Active"
  }

  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
    # INFO, not WARN: WARN drops the START and REPORT lines (duration, memory, cold start).
    system_log_level = "INFO"
    log_group        = aws_cloudwatch_log_group.api.name
  }

  environment {
    variables = {
      TABLE_NAME         = var.table_name
      ARTIFACTS_BUCKET   = var.artifacts_bucket
      PIPELINE_ALIAS_ARN = var.pipeline_alias_arn
      ATTEMPT_BUDGET     = tostring(var.attempt_budget)
      IMAGE_MODEL        = var.image_model
      IMAGE_SIZE         = var.image_size
      IMAGE_QUALITY      = var.image_quality
      LOG_LEVEL          = "INFO"
      # Review notes are screened before the callback (routes/revisions.ts).
      GUARDRAIL_ID      = var.guardrail_id
      GUARDRAIL_VERSION = var.guardrail_version
      # Both slots: CloudFront sends one, and the other stays valid through a rotation.
      ORIGIN_VERIFY_SECRETS = join(",", [for slot in ["a", "b"] : random_password.origin_verify[slot].result])
      # The per-user token exchange (shared/src/store/scope.ts): every store call goes through
      # this role, assumed with the caller's `sub` as a session tag, and never through the
      # function's own role, which has no DynamoDB or S3 access.
      USER_DATA_ROLE_ARN        = aws_iam_role.user_data.arn
      STORE_REQUIRES_USER_SCOPE = "true"
    }
  }

  kms_key_arn = var.data_key_arn

  # Caps concurrent paid model calls and blast radius; -1 leaves the function unreserved.
  reserved_concurrent_executions = var.reserved_concurrency

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }
}

/**
 * The secret CloudFront adds as the `x-origin-verify` origin header and the function checks, so
 * the `execute-api` URL is useless without CloudFront (and its WAF) in front. An HTTP API has no
 * resource policy or WAF association to do this at the gateway. Two slots for rotation:
 * CloudFront sends `origin_secret_slot`, the function accepts both (infra/README.md).
 */
resource "random_password" "origin_verify" {
  for_each = toset(["a", "b"])

  length  = 48
  special = false
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.name}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_key_arn
}

/**
 * A failed submit must not vanish. The queue holds the event so the revision can be
 * redriven rather than sitting in the UI as a run that never started.
 */
resource "aws_sqs_queue" "dlq" {
  name                              = "${var.name}-api-dlq"
  kms_master_key_id                 = var.data_key_arn
  kms_data_key_reuse_period_seconds = 300
  message_retention_seconds         = 1209600 # 14 days
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_xray" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
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

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

data "aws_iam_policy_document" "api" {
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
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  # No DynamoDB or S3 here: the function reaches user data only by assuming the user-data role
  # below with the caller's `sub` as the one session tag. Both actions are needed: AssumeRole,
  # and TagSession to pass the tag (https://docs.aws.amazon.com/IAM/latest/UserGuide/id_session-tags.html).
  statement {
    sid       = "AssumeUserData"
    effect    = "Allow"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = [aws_iam_role.user_data.arn]
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

  # Qualified ARN only. An unqualified invoke of a durable function is rejected, so
  # granting the unqualified ARN here would just hide the error behind AccessDenied.
  statement {
    sid       = "StartPipeline"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.pipeline_alias_arn]
  }

  /**
   * Resolving the human review gate. Scoped to every qualifier of the pipeline function
   * because a callback belongs to an execution that may have started on an earlier
   * published version than the one `live` points at today.
   */
  statement {
    sid    = "ResolveReviewGate"
    effect = "Allow"

    actions = [
      "lambda:SendDurableExecutionCallbackSuccess",
      "lambda:SendDurableExecutionCallbackFailure",
      "lambda:SendDurableExecutionCallbackHeartbeat",
    ]

    resources = [
      var.pipeline_function_arn,
      "${var.pipeline_function_arn}:*",
    ]
  }

  statement {
    sid       = "Dlq"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

/**
 * The user-data role: the only way the API reaches DynamoDB and S3.
 *
 * Assumed per request by the API function with the caller's verified `sub` as a session tag.
 * Every permission is limited to keys that start with that tag, so a request can only reach its
 * caller's own revisions and artifacts, even if the code built a wrong key: IAM denies it.
 *   DynamoDB: partition key `USER#{sub}#…` (dynamodb:LeadingKeys, plus a Null check so a request
 *             without a partition key, such as a Scan, is not let through by ForAllValues)
 *   S3:       objects under `user/{sub}/` (a policy variable in the resource ARN)
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_variables.html
 *
 * `$${...}` is Terraform's escape for a literal `${...}`: the policy variable is resolved by IAM
 * at request time, not by Terraform. The `sub` cannot contain `*` or `?` (not session-tag
 * characters, and refused by shared/src/store/owner.ts), so StringLike matches only that prefix.
 *
 * The pipeline does not use this role: it runs for days after the user's session has ended and
 * keeps its service role. Recorded in docs/spec/13-decisions.md.
 */
resource "aws_iam_role" "user_data" {
  name               = "${var.name}-api-user-data"
  description        = "Per-user access to revisions and artifacts, assumed by the API with the caller's sub as a session tag."
  assume_role_policy = data.aws_iam_policy_document.user_data_trust.json
  # Role chaining caps the session at one hour whatever this says; set to match.
  max_session_duration = 3600
}

data "aws_iam_policy_document" "user_data_trust" {
  # Only the API function's role, and only with exactly one session tag, `sub`.
  statement {
    sid     = "ApiWithSubTag"
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.api.arn]
    }

    # Present (StringLike on an absent key is false) and non-empty.
    condition {
      test     = "StringLike"
      variable = "aws:RequestTag/sub"
      values   = ["?*"]
    }

    # No other tag keys. ForAllValues is true when the key is absent, which the condition
    # above already rules out.
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["sub"]
    }
  }
}

resource "aws_iam_role_policy" "user_data" {
  name   = "user-data"
  role   = aws_iam_role.user_data.id
  policy = data.aws_iam_policy_document.user_data.json
}

data "aws_iam_policy_document" "user_data" {
  # The four calls the store makes. No Scan, no BatchGet, no Delete.
  statement {
    sid       = "OwnRevisions"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [var.table_arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["USER#$${aws:PrincipalTag/sub}#*"]
    }

    condition {
      test     = "Null"
      variable = "dynamodb:LeadingKeys"
      values   = ["false"]
    }
  }

  # Presigned uploads and downloads, and confirm's HEAD and ranged read (both s3:GetObject).
  statement {
    sid       = "OwnArtifacts"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.artifacts_arn}/user/$${aws:PrincipalTag/sub}/*"]
  }

  # The table and the bucket are encrypted with the data key.
  statement {
    sid       = "DataKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [var.data_key_arn]
  }
}

resource "aws_apigatewayv2_api" "main" {
  name          = var.name
  protocol_type = "HTTP"

  # Only cross-origin callers need CORS (the local dev SPA calling the CloudFront URL); the
  # deployed SPA calls /api/* on its own origin.
  cors_configuration {
    allow_origins     = var.allowed_web_origins
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_headers     = ["authorization", "content-type", "if-none-match"]
    expose_headers    = ["etag"]
    allow_credentials = false
    max_age           = 300
  }
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito"

  jwt_configuration {
    audience = [var.user_pool_client]
    issuer   = var.user_pool_endpoint
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"

  # Matches the Lambda timeout, so a slow call ends in the function's own error handling
  # rather than a bare API Gateway 503.
  timeout_milliseconds = 30000
}

/**
 * Enumerated rather than proxied with `$default`, so an unimplemented path is a 404 from
 * API Gateway and there is no unauthenticated catch-all route.
 *
 * Must match the dispatch table in `api/src/handler.ts`; parsed and asserted by
 * `api/test/routes.test.ts`, because a route missing here 404s in production
 * while working against the local mock.
 */
locals {
  routes = [
    "GET /api/models",
    "POST /api/uploads/presign",
    "POST /api/uploads/confirm",
    "POST /api/revisions",
    "GET /api/revisions/{id}",
    "POST /api/revisions/{id}/review",
  ]
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = toset(local.routes)

  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    # Image generation costs real money per call; cap the blast radius of a runaway
    # client at the edge as well as in WAF.
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      integrationErr = "$context.integrationErrorMessage"
      requestTime    = "$context.requestTime"
    })
  }
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_key_arn
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
