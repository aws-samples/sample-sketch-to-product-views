variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "account_id" {
  description = "Account ID, suffixed onto the bucket name so it stays globally unique."
  type        = string
}

variable "region" {
  description = "Region of the web and artifacts buckets."
  type        = string
}

variable "web_acl_arn" {
  description = "CLOUDFRONT-scoped WAFv2 web ACL ARN (us-east-1), e.g. module.security.cloudfront_web_acl_arn."
  type        = string
}

variable "logs_bucket" {
  description = "Bucket id receiving S3 server access logs for the web bucket."
  type        = string
}

variable "logs_bucket_arn" {
  description = "ARN of the same bucket: the CloudFront logging v2 destination."
  type        = string
}

variable "logs_bucket_policy_id" {
  description = "module.storage.logs_bucket_policy_id. Log deliveries wait on it: the bucket policy is what admits them."
  type        = string
}

variable "log_prefix" {
  description = "Key prefix of the CloudFront access logs."
  type        = string
  default     = "cloudfront/web/"
}

variable "artifacts_bucket" {
  description = "Artifacts bucket. Its CORS config is owned here: browsers PUT presigned uploads to it from this distribution's origin."
  type        = string
}

variable "allowed_web_origins" {
  description = "Origins besides this distribution allowed to upload to the artifacts bucket, e.g. the local dev SPA."
  type        = list(string)
  default     = []
}

variable "api_origin_domain" {
  description = "execute-api host name of the HTTP API, served under /api/*."
  type        = string
}

variable "api_origin_secret" {
  description = "Value of the x-origin-verify header CloudFront adds to API requests."
  type        = string
  sensitive   = true
}

variable "csp_connect_sources" {
  description = "Extra CSP connect-src origins, e.g. the Cognito hosted UI. 'self' (the API) and the artifacts bucket are added by the module."
  type        = list(string)
  default     = []
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"
}

variable "domain_name" {
  description = "Optional custom domain for the SPA (e.g. views.example.com). With acm_certificate_arn it enforces TLS 1.2; point its DNS at the distribution yourself."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate for domain_name, issued in us-east-1 (CloudFront's requirement)."
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:us-east-1:", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate in us-east-1."
  }
}
