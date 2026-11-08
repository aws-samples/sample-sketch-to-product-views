variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "table_name" {
  description = "DynamoDB table the handlers read and write."
  type        = string
}

variable "table_arn" {
  description = "ARN of that table, used to scope the IAM policy."
  type        = string
}

variable "artifacts_bucket" {
  description = "Bucket uploads are presigned against."
  type        = string
}

variable "artifacts_arn" {
  description = "ARN of the artifacts bucket, used to scope the IAM policy."
  type        = string
}

variable "data_key_arn" {
  description = "CMK encrypting the table, the artifacts bucket, the DLQ and this function's environment variables."
  type        = string
}

variable "logs_key_arn" {
  description = "CMK encrypting the Lambda and API access log groups."
  type        = string
}

variable "log_retention_days" {
  description = "Retention for the Lambda and API access log groups."
  type        = number
}

variable "user_pool_endpoint" {
  description = "Issuer URL for the JWT authorizer."
  type        = string
}

variable "user_pool_client" {
  description = "Expected audience claim."
  type        = string
}

variable "pipeline_alias_arn" {
  description = "Qualified pipeline ARN. Durable invocations must be qualified."
  type        = string
}

variable "pipeline_function_arn" {
  description = "Unqualified pipeline ARN, used to scope review-callback permissions across versions."
  type        = string
}

variable "allowed_web_origins" {
  description = "Cross-origin callers allowed by the HTTP API's CORS configuration, e.g. the local dev SPA. The deployed SPA is same-origin."
  type        = list(string)
}

variable "attempt_budget" {
  description = "2D generation and evaluation attempt ceiling recorded on each new revision."
  type        = number
}

variable "image_size" {
  description = "Default view size shown on the start form; empty means the image model's registry default."
  type        = string
  default     = ""
}

variable "image_quality" {
  description = "Default view quality shown on the start form; empty means the image model's registry default."
  type        = string
  default     = ""
}

variable "image_model" {
  description = "Registry id of the image model a run gets when it names none; empty means the registry default. See the same variable in envs/dev."
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

variable "origin_secret_slot" {
  description = "Which origin secret (a or b) CloudFront sends; the function accepts both. Flip it to rotate (infra/README.md)."
  type        = string
  default     = "a"

  validation {
    condition     = contains(["a", "b"], var.origin_secret_slot)
    error_message = "origin_secret_slot must be \"a\" or \"b\"."
  }
}

variable "reserved_concurrency" {
  description = "Reserved concurrent executions for the API function; -1 for none."
  type        = number
}
