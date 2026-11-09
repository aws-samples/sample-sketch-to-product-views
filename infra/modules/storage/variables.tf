variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "account_id" {
  description = "Account id, suffixed onto every bucket name so they are globally unique."
  type        = string
}

variable "region" {
  description = "Region, suffixed onto every bucket name so they are globally unique."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK encrypting the artifacts bucket and the table."
  type        = string
}

variable "deletion_protection" {
  description = "Deletion protection on the table. Off in dev so the environment can be torn down."
  type        = bool
  default     = false
}
