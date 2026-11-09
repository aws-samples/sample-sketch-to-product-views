/**
 * Two buckets, one table:
 *   - artifacts bucket: sketches, generated candidates, delivered assets
 *   - logs bucket:      S3 + CloudFront access logs
 *   - one DynamoDB table: revisions, the append-only stage-event log, model registry
 *
 * A single table keeps the stage-event log and the revision it belongs to in one
 * partition, so a status read is one Query rather than a fan-out.
 */

# This is the log-delivery target bucket itself; AWS's own guidance is to suppress the
# logging-enabled check for it rather than chain it to another bucket (Security Hub S3.9:
# "The target logging bucket does not need to have server access logging enabled, and you
# should suppress findings for this bucket.").
#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "logs" {
  bucket = "${var.name}-logs-${var.account_id}-${var.region}"
}

# ACLs off: S3 server access logs and CloudFront logging v2 are both granted by the bucket
# policy below, not by the log-delivery ACL.
resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, not the CMK: S3 server access logging cannot write to a bucket encrypted
# with a customer-managed key (AWS docs: "logging destination buckets must not have
# KMS encryption enabled").
#tfsec:ignore:aws-s3-encryption-customer-key
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json
}

locals {
  # The web bucket lives in the web module, which depends on this one; its name is fixed.
  log_source_buckets = [
    aws_s3_bucket.artifacts.arn,
    "arn:aws:s3:::${var.name}-web-${var.account_id}-${var.region}",
  ]
}

data "aws_iam_policy_document" "logs" {
  source_policy_documents = [data.aws_iam_policy_document.tls_only["logs"].json]

  # https://docs.aws.amazon.com/AmazonS3/latest/userguide/enable-server-access-logging.html
  statement {
    sid       = "S3ServerAccessLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/s3/*"]

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = local.log_source_buckets
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }

  # CloudFront logging v2 (CloudWatch vended logs):
  # https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AWS-logs-infrastructure-V2-S3.html
  statement {
    sid       = "AWSLogDeliveryWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:${var.region}:${var.account_id}:delivery-source:*"]
    }
  }

  statement {
    sid       = "AWSLogDeliveryAclCheck"
    actions   = ["s3:GetBucketAcl", "s3:ListBucket"]
    resources = [aws_s3_bucket.logs.arn]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:${var.region}:${var.account_id}:delivery-source:*"]
    }
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.name}-artifacts-${var.account_id}-${var.region}"
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = var.kms_key_arn
      sse_algorithm     = "aws:kms"
    }

    # Sketches and candidates are written and read in bursts by one principal;
    # a bucket key cuts the KMS request count sharply.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_logging" "artifacts" {
  bucket        = aws_s3_bucket.artifacts.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/artifacts/"

  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "tidy"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# The artifacts bucket's CORS config is owned by `modules/web`: its allowed-origin list needs
# the CloudFront domain, and storage cannot depend on web without a cycle.

resource "aws_s3_bucket_policy" "artifacts_tls_only" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.tls_only["artifacts"].json
}

# One document per bucket: both carry the same deny, and an object-level ARN cannot be
# wildcarded across buckets without also matching buckets this module does not own.
data "aws_iam_policy_document" "tls_only" {
  for_each = {
    artifacts = aws_s3_bucket.artifacts.arn
    logs      = aws_s3_bucket.logs.arn
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      each.value,
      "${each.value}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

/**
 * Single-table design.
 *
 *   pk = REV#{revisionId}   sk = META                  the revision
 *   pk = REV#{revisionId}   sk = EVENT#{seq padded}    the stage-event log
 *   pk = MODEL#{modelId}    sk = META                  the registry entry
 *
 * Events sort under their revision, so the UI projection is one Query with no
 * secondary index. Zero-padded seq keeps lexicographic order equal to numeric order.
 */
resource "aws_dynamodb_table" "main" {
  name         = var.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = var.deletion_protection
}
