/**
 * Remote state. A config cannot bootstrap its own state bucket, so the bucket came first on local
 * state, then `terraform init -migrate-state`.
 *
 * A backend block cannot read variables, so the settings that name an account (state bucket, KMS
 * key) come per account as a partial configuration
 * (https://developer.hashicorp.com/terraform/language/backend#partial-configuration):
 *
 *   terraform init -backend-config=backend/example.s3.tfbackend
 */

terraform {
  backend "s3" {
    key          = "dev/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
