variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "account_id" {
  description = "Account owning the Bedrock inference profiles the pipeline may invoke."
  type        = string
}

variable "table_name" {
  description = "DynamoDB table the stage-event log is written to."
  type        = string
}

variable "table_arn" {
  description = "ARN of that table, used to scope the IAM policy."
  type        = string
}

variable "artifacts_bucket" {
  description = "Bucket holding sketches, candidates and delivered assets."
  type        = string
}

variable "artifacts_arn" {
  description = "ARN of the artifacts bucket, used to scope the IAM policy."
  type        = string
}

variable "data_key_arn" {
  description = "CMK encrypting the table, the artifacts bucket and this function's environment variables."
  type        = string
}

variable "logs_key_arn" {
  description = "CMK encrypting this function's CloudWatch log group."
  type        = string
}

variable "log_retention_days" {
  description = "Retention for this function's CloudWatch log group."
  type        = number
}

variable "image_model" {
  description = "Default 2D image generation model, by registry id; empty means the registry default. See the same variable in envs/dev."
  type        = string
  default     = ""
}

variable "image_size" {
  description = "Size of every generated view; empty means the image model's registry default. See the same variable in envs/dev."
  type        = string
  default     = ""
}

variable "image_quality" {
  description = "Quality of every generated view; empty means the image model's registry default. See the same variable in envs/dev."
  type        = string
  default     = ""
}

variable "analyser_model" {
  description = "The analyser, by registry id; empty means the registry default. See the same variable in envs/dev."
  type        = string
  default     = ""
}

variable "evaluation_model" {
  description = "The critic (evaluation), by registry id."
  type        = string
}

variable "attempt_budget" {
  description = "Maximum 2D generation and evaluation attempts. Enforced in the durable loop, not the UI."
  type        = number
}

variable "review_timeout_days" {
  description = "Drives both the human review gate's callback wait and the function's execution_timeout."
  type        = number
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
    field), for the models whose registry provider is openai. Created outside Terraform
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

variable "guardrail_id" {
  description = "Bedrock guardrail id, set as GUARDRAIL_ID; empty turns screening off."
  type        = string
  default     = ""
}

variable "guardrail_version" {
  description = "Published guardrail version, set as GUARDRAIL_VERSION."
  type        = string
  default     = ""
}

variable "guardrail_arn" {
  description = "Guardrail ARN, the resource of bedrock:ApplyGuardrail; empty grants nothing."
  type        = string
  default     = ""
}

variable "reserved_concurrency" {
  description = "Reserved concurrent executions for the pipeline function; -1 for none."
  type        = number
}
