/**
 * Two customer-managed keys rather than one:
 *   - data: S3 objects, DynamoDB items, SQS payloads, durable execution state
 *   - logs: CloudWatch log groups, which need a different key policy
 *
 * Splitting them means the log key can be granted to the CloudWatch Logs service
 * principal without that grant also covering product data.
 */

resource "aws_kms_key" "data" {
  description             = "${var.name} application data (S3, DynamoDB, SQS, durable state)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.data_key.json
}

locals {
  # Matches `function_name` in modules/pipeline.
  pipeline_function_arn = "arn:aws:lambda:${var.region}:${var.account_id}:function:${var.name}-pipeline"
}

# https://docs.aws.amazon.com/lambda/latest/dg/durable-encryption.html
data "aws_iam_policy_document" "data_key" {
  # checkov:skip=CKV_AWS_109,CKV_AWS_111,CKV_AWS_356:key policy; Resource "*" means this key (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html)
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  # Lambda encrypts the pipeline's durable checkpoints with its own service credentials. The
  # execution role's Decrypt comes from its IAM policy, allowed by the statement above.
  statement {
    sid       = "LambdaDurableState"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.pipeline_function_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:lambda:FunctionArn"
      values   = [local.pipeline_function_arn]
    }
  }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "logs" {
  description             = "${var.name} CloudWatch Logs"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.logs_key.json
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

data "aws_iam_policy_document" "logs_key" {
  # checkov:skip=CKV_AWS_109,CKV_AWS_111,CKV_AWS_356:key policy; Resource "*" means this key (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html)
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  # Durable-execution state and step results land in these log groups, which is
  # exactly why they are encrypted with a CMK.
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]

    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:*"]
    }
  }
}

/**
 * CLOUDFRONT-scoped web ACLs must live in us-east-1 regardless of where the rest
 * of the stack is. This is the only reason the aliased provider exists.
 *
 * It protects the SPA and the API (`/api/*` on the same distribution). Body rules inspect the
 * first 16 KB, CloudFront's default body inspection limit.
 */
resource "aws_wafv2_web_acl" "cloudfront" {
  provider = aws.us_east_1

  name  = "${var.name}-cloudfront"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # SizeRestrictions_BODY blocks bodies over 8 KB
  # (https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html#aws-managed-rule-groups-baseline-crs).
  # Product details (up to 64 KB) and review notes (4,000 characters) exceed it, so the rule only
  # counts and labels here; BodySizeOutsideRevisions blocks on its label everywhere else. Every
  # other rule in the group still blocks.
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }

  # The label exception pattern from
  # https://docs.aws.amazon.com/waf/latest/developerguide/waf-bot-control-example-user-agent-exception.html:
  # an oversize body is blocked unless it is a POST /api/revisions or /api/revisions/{id}/review.
  # Other methods on those paths have no route. The API validates those bodies' sizes itself.
  rule {
    name     = "BodySizeOutsideRevisions"
    priority = 2

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          label_match_statement {
            scope = "LABEL"
            key   = "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
          }
        }

        statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/revisions"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-body-size"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # Every request per IP over 5 minutes, API calls included. A run page polls about once a
  # second (300 per window), so the ceiling leaves room for a few tabs and the SPA's assets.
  rule {
    name     = "RateLimit"
    priority = 4

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # API writes start paid image generation: far below what a reviewer needs (a run is about a
  # dozen POSTs: presign and confirm per file, submit, review).
  rule {
    name     = "RateLimitApiWrites"
    priority = 5

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "/api/"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit-writes"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-cloudfront"
    sampled_requests_enabled   = true
  }
}

/**
 * A KMS key must live in the same Region as the log group it encrypts, so the WAF log group
 * gets its own key through the us-east-1 provider, whatever Region the stack runs in.
 */
resource "aws_kms_key" "waf_logs" {
  provider = aws.us_east_1

  description             = "${var.name} WAF CloudWatch Logs (us-east-1)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.waf_logs_key.json
}

resource "aws_kms_alias" "waf_logs" {
  provider = aws.us_east_1

  name          = "alias/${var.name}-waf-logs"
  target_key_id = aws_kms_key.waf_logs.key_id
}

data "aws_iam_policy_document" "waf_logs_key" {
  # checkov:skip=CKV_AWS_109,CKV_AWS_111,CKV_AWS_356:key policy; Resource "*" means this key (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html)
  statement {
    sid       = "AccountAdmin"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]

    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.us-east-1.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:us-east-1:${var.account_id}:log-group:*"]
    }
  }
}

/**
 * Request-level WAF logs, without which a blocked request leaves only a metric. The log
 * group name must carry the `aws-waf-logs-` prefix and must live in the same Region as the
 * web ACL, so it is created through the us-east-1 provider and encrypted with the us-east-1
 * key above. The Authorization header is redacted so bearer tokens are never persisted.
 */
resource "aws_cloudwatch_log_group" "waf" {
  provider = aws.us_east_1

  name              = "aws-waf-logs-${var.name}-cloudfront"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.waf_logs.arn
}

resource "aws_wafv2_web_acl_logging_configuration" "cloudfront" {
  provider = aws.us_east_1

  resource_arn            = aws_wafv2_web_acl.cloudfront.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}
