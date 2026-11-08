terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      # 6.71.0 adds `durable_config.kms_key_arn`.
      source  = "hashicorp/aws"
      version = ">= 6.71.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.7"
    }
  }
}
