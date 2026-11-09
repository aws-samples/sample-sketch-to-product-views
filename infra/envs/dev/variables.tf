variable "region" {
  description = "Region for every resource except the two CloudFront-scoped exceptions."
  type        = string
  default     = "us-east-1"

  validation {
    # The registry's Bedrock entries are US inference profiles (`us.*`); another Region needs
    # them and durable-function availability re-checked first.
    condition     = var.region == "us-east-1"
    error_message = "This sample is pinned to us-east-1. See infra/README.md before changing it."
  }
}

variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "s2pv"
}

variable "environment" {
  description = "Environment name, used in resource names and tags."
  type        = string
  default     = "dev"
}

variable "image_model" {
  description = <<-EOT
    Default 2D image generation model, named by its **registry id**
    (`shared/src/registry/models/*.yaml`), not by its Bedrock model id. The API uses it
    for a run that names no model and as the start form's default; a run can still pick another
    entry by id.

    The registry entry carries the provider, the model id, the endpoint Region, the residency
    list and the field map, so naming the entry keeps those facts in one place. Putting a raw
    Bedrock id here instead would tell the pipeline which model to call but not how to call it,
    and the two could drift.

    Empty means the registry's default (`isDefault: true`). Swapping models is a `-var` or a
    tfvars file and an apply, with no code change, as long as the target already has a YAML
    entry. Adding a genuinely new model is a new YAML file, which is right: it needs a field
    map and has to pass the registry's validation.
  EOT
  type        = string
  default     = ""
}

variable "image_size" {
  description = <<-EOT
    Size of every generated view, as one of the image model's registry `size` options
    (`2336x3504` is the validated default, `1536x2304` the fallback). Empty means the registry
    default. The four views of an attempt always share it. A value the entry does not offer
    fails generation with a message naming the options.
  EOT
  type        = string
  default     = ""
}

variable "image_quality" {
  description = <<-EOT
    Quality of every generated view, as one of the image model's registry `quality` options
    (`max` is the validated default, its per-image price unpublished; `high` the fallback). Empty
    means the registry default.
  EOT
  type        = string
  default     = ""
}

variable "analyser_model" {
  description = <<-EOT
    The analyser, also a registry id (category `analyser`). The entry's `provider` decides
    the transport: `analyser-luna-litellm` goes through a LiteLLM gateway and needs
    `litellm_api_key_secret_arn`; `analyser-luna-openai` calls OpenAI's API directly and needs
    `openai_api_key_secret_arn`; `analyser-luna-bedrock` calls Bedrock with the function's
    role. Empty means the registry's default.
  EOT
  type        = string
  default     = ""
}

variable "evaluation_model" {
  description = <<-EOT
    The critic (evaluation), also a registry id.
  EOT
  type        = string
  default     = "critic-sonnet"
}

variable "attempt_budget" {
  description = "Maximum 2D generation and evaluation attempts per revision."
  type        = number
  default     = 2

  validation {
    condition     = var.attempt_budget >= 1 && var.attempt_budget <= 10
    error_message = "attempt_budget must be between 1 and 10."
  }
}

variable "review_timeout_days" {
  description = <<-EOT
    How long the human review gate's durable wait holds before failing the revision. Also drives
    the function's execution_timeout, which is why it must stay under the 90-day state retention
    ceiling.
  EOT
  type        = number
  default     = 7

  validation {
    condition     = var.review_timeout_days >= 1 && var.review_timeout_days <= 90
    error_message = "review_timeout_days must be between 1 and 90."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention for every log group in this environment."
  type        = number
  default     = 365
}

variable "allowed_web_origins" {
  description = "Extra origins, e.g. the local dev SPA: Cognito callbacks, API CORS (calling the CloudFront URL) and artifacts-bucket CORS. The CloudFront site is added automatically."
  type        = list(string)
  default     = ["http://127.0.0.1:5273", "http://localhost:5273"]
}

variable "litellm_base_url" {
  description = "LiteLLM gateway URL, for the models whose registry provider is litellm."
  type        = string
  default     = "https://litellm.example.internal"
}

variable "litellm_api_key_secret_arn" {
  description = <<-EOT
    Secrets Manager ARN of the LiteLLM virtual key (the bare key, or JSON with an apiKey
    field). Created outside Terraform so the key never lands in the state. Empty means no
    LiteLLM model can be called from this function.
  EOT
  type        = string
  default     = ""
}

variable "openai_api_key_secret_arn" {
  description = <<-EOT
    Secrets Manager ARN of the OpenAI project API key (the bare key, or JSON with an apiKey
    field), for the models whose registry provider is openai (the `*-openai` entries). Created outside Terraform
    so the key never lands in the state. Empty means no OpenAI-direct model can be called, and
    the role gets no permission on any secret for it.
  EOT
  type        = string
  default     = ""
}

variable "openai_organization" {
  description = "OpenAI organization id, sent as the OpenAI-Organization header. Empty sends none."
  type        = string
  default     = ""
}

variable "openai_project" {
  description = "OpenAI project id, sent as the OpenAI-Project header. Empty sends none."
  type        = string
  default     = ""
}

variable "guardrail_enabled" {
  description = <<-EOT
    Creates a Bedrock guardrail (content filters and prompt-attack detection on text) and has
    both functions screen every free-text input with it. False leaves the functions unscreened
    (text is still sanitised). See README "Security".
  EOT
  type        = bool
  default     = true
}

variable "web_domain_name" {
  description = "Optional custom domain for the web UI. With web_acm_certificate_arn, CloudFront enforces TLS 1.2 (the default *.cloudfront.net certificate allows TLS 1.0). Create the DNS record yourself."
  type        = string
  default     = ""
}

variable "web_acm_certificate_arn" {
  description = "ACM certificate covering web_domain_name, in us-east-1."
  type        = string
  default     = ""
}

variable "origin_secret_slot" {
  description = "Origin secret slot (a or b) CloudFront sends to the API; flip it to rotate the secret (infra/README.md)."
  type        = string
  default     = "a"
}

variable "cognito_threat_protection" {
  description = <<-EOT
    Cognito threat protection mode: ENFORCED (default; adaptive authentication and
    compromised-credentials blocking), AUDIT (risk logged, nothing blocked) or OFF. AUDIT and
    ENFORCED need the Plus feature plan, which is billed per monthly active user
    (https://aws.amazon.com/cognito/pricing/); OFF moves the pool to Essentials.
  EOT
  type        = string
  default     = "ENFORCED"
}

variable "api_reserved_concurrency" {
  description = "Reserved concurrency of the API function. Taken from the account's unreserved pool, which must keep at least 100; set -1 on an account with a low concurrency limit."
  type        = number
  default     = 20
}

variable "pipeline_reserved_concurrency" {
  description = "Reserved concurrency of the pipeline function: at most this many runs make model calls at once (a run waiting for review holds none). -1 for none."
  type        = number
  default     = 10
}
