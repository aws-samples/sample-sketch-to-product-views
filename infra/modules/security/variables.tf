variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "region" {
  description = "Region whose CloudWatch Logs service principal is granted use of the logs key."
  type        = string
}

variable "account_id" {
  description = "Account owning the keys."
  type        = string
}

variable "log_retention_days" {
  description = "Retention for the us-east-1 WAF log group."
  type        = number
  default     = 365
}
