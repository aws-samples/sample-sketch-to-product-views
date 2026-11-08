locals {
  custom_domain = var.domain_name != "" && var.acm_certificate_arn != ""
  site_origin   = "https://${local.custom_domain ? var.domain_name : aws_cloudfront_distribution.web.domain_name}"
}

/**
 * The SPA: a private S3 bucket served by CloudFront through Origin Access Control. No public
 * access, no website endpoint; the bucket policy admits only this distribution.
 *
 * A second origin serves `/api/*` from the HTTP API, so every API call passes the same WAF web
 * ACL and the SPA calls it same-origin. CloudFront adds a secret header the API function checks,
 * which makes the `execute-api` URL useless on its own.
 */

locals {
  # The origin presigned URLs point at (virtual-hosted style), for uploads and image reads.
  artifacts_origin = "https://${var.artifacts_bucket}.s3.${var.region}.amazonaws.com"

  # React Flow positions nodes with inline style attributes, hence 'unsafe-inline' for styles only.
  content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: ${local.artifacts_origin}",
    "connect-src 'self' ${join(" ", concat([local.artifacts_origin], var.csp_connect_sources))}",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
}

resource "aws_s3_bucket" "web" {
  bucket = "${var.name}-web-${var.account_id}-${var.region}"
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Own key: its policy names this distribution, which depends on the security module's keys.
resource "aws_kms_key" "web" {
  description             = "${var.name} web UI bucket"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.web_key.json
}

resource "aws_kms_alias" "web" {
  name          = "alias/${var.name}-web"
  target_key_id = aws_kms_key.web.key_id
}

# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
data "aws_iam_policy_document" "web_key" {
  # checkov:skip=CKV_AWS_109,CKV_AWS_111,CKV_AWS_356:key policy; Resource "*" means this key (https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html)
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid       = "CloudFrontReadThisDistribution"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.web.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Each deploy replaces the build; old versions are only a short rollback window.
resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    id     = "expire-old-builds"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.web]
}

resource "aws_s3_bucket_logging" "web" {
  bucket        = aws_s3_bucket.web.id
  target_bucket = var.logs_bucket
  target_prefix = "s3/web/"

  depends_on = [terraform_data.logs_ready]
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "web" {
  name    = "${var.name}-web-security"
  comment = "Security headers for the SPA."

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Every API response is per user; nothing is cached at the edge.
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

/**
 * Only what the API reads. Not the managed AllViewerExceptHostHeader: it forwards all cookies,
 * and CloudFront does not support If-None-Match conditional requests when cookies are forwarded
 * (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html#RequestCustomConditionalGETs).
 * - authorization: CloudFront strips it from GET and HEAD unless a policy forwards it
 *   (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html#add-origin-custom-headers-forward-authorization).
 * - Host is not forwarded, so CloudFront sends the execute-api host name, which API Gateway
 *   needs (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).
 * - origin and access-control-request-*: CORS preflights from the local dev SPA.
 */
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.name}-api"
  comment = "Headers and query strings the HTTP API reads."

  cookies_config {
    cookie_behavior = "none"
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = [
        "authorization",
        "content-type",
        "if-none-match",
        "origin",
        "access-control-request-method",
        "access-control-request-headers",
      ]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

# Log delivery starts only once the logs bucket policy admits it.
resource "terraform_data" "logs_ready" {
  input = var.logs_bucket_policy_id
}

# CloudFront logging v2 (CloudWatch vended logs, us-east-1): the logs bucket keeps ACLs off.
# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html
resource "aws_cloudwatch_log_delivery_source" "web" {
  name         = "${var.name}-web-access"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.web.arn
}

resource "aws_cloudwatch_log_delivery_destination" "web" {
  name          = "${var.name}-web-access"
  output_format = "w3c"

  delivery_destination_configuration {
    destination_resource_arn = "${var.logs_bucket_arn}/${trimsuffix(var.log_prefix, "/")}"
  }
}

resource "aws_cloudwatch_log_delivery" "web" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.web.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.web.arn

  depends_on = [terraform_data.logs_ready]
}

resource "aws_cloudfront_distribution" "web" { # nosemgrep: terraform.aws.security.aws-cloudfront-insecure-tls.aws-insecure-cloudfront-distribution-tls-version
  # checkov:skip=CKV_AWS_174:TLS 1.2 needs a custom domain (web_domain_name); the default certificate forces TLSv1
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${var.name} SPA"
  default_root_object = "index.html"
  price_class         = var.price_class
  web_acl_id          = var.web_acl_arn
  aliases             = local.custom_domain ? [var.domain_name] : []

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    domain_name = var.api_origin_domain
    origin_id   = "api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # Matches the API Lambda and integration timeouts.
      origin_read_timeout = 30
    }

    # Overwrites any viewer-sent value; checked by api/src/origin.ts.
    custom_header {
      name  = "x-origin-verify"
      value = var.api_origin_secret
    }
  }

  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  # CloudFront allows only GET/HEAD, GET/HEAD/OPTIONS or all seven methods; the API needs POST.
  # Methods without a route are a 404 from API Gateway.
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  # No custom error responses: they apply to every origin and would turn the API's 403 and 404
  # into the SPA shell. Runs live at `#/r/{id}`, so only `/` and `/assets/*` reach S3.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # With the default *.cloudfront.net certificate CloudFront always uses the TLSv1 policy;
  # TLS 1.2+ needs a custom domain with an ACM certificate (SNI).
  # https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html
  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web.json

  depends_on = [aws_s3_bucket_public_access_block.web]
}

data "aws_iam_policy_document" "web" {
  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # This distribution only, so another distribution's OAC cannot read the bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.web.arn,
      "${aws_s3_bucket.web.arn}/*",
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

# Owned here because the allowed origins include this distribution's domain.
resource "aws_s3_bucket_cors_configuration" "artifacts" {
  bucket = var.artifacts_bucket

  cors_rule {
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = concat(var.allowed_web_origins, distinct(["https://${aws_cloudfront_distribution.web.domain_name}", local.site_origin]))
    # The presigned PUT only sends Content-Type.
    allowed_headers = ["content-type"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
