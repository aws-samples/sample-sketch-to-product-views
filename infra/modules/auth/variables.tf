variable "name" {
  description = "Resource name prefix. Also used as the Cognito hosted-UI domain prefix, so it must be globally unique within the Region."
  type        = string
}

variable "allowed_web_origins" {
  description = "Origins registered as OAuth callback and logout URLs for the SPA client."
  type        = list(string)
}

variable "threat_protection" {
  description = "Cognito threat protection: ENFORCED (block or challenge risky sign-ins), AUDIT (log only) or OFF. AUDIT and ENFORCED put the pool on the Plus feature plan."
  type        = string
  default     = "ENFORCED"

  validation {
    condition     = contains(["ENFORCED", "AUDIT", "OFF"], var.threat_protection)
    error_message = "threat_protection must be ENFORCED, AUDIT or OFF."
  }
}
