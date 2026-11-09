variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed key encrypting the guardrail at rest (the data key)."
  type        = string
}
