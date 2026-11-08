locals {
  name = "${var.project}-${var.environment}"

  # Cognito callback/logout URLs: the dev SPA and the CloudFront site. The API's CORS list is only
  # var.allowed_web_origins: the site calls /api/* same-origin.
  web_origins = concat(var.allowed_web_origins, distinct(["https://${module.web.distribution_domain}", module.web.site_origin]))

  # Matches `function_name` in modules/pipeline: "${var.name}-pipeline".
  pipeline_function_arn = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name}-pipeline"

  tags = {
    Project     = "sketch-to-product-views"
    Environment = "dev"
    ManagedBy   = "terraform"
  }
}

data "aws_caller_identity" "current" {}

module "security" {
  source = "../../modules/security"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name               = local.name
  region             = var.region
  account_id         = data.aws_caller_identity.current.account_id
  log_retention_days = var.log_retention_days
}

module "storage" {
  source = "../../modules/storage"

  name        = local.name
  account_id  = data.aws_caller_identity.current.account_id
  region      = var.region
  kms_key_arn = module.security.data_key_arn
}

module "auth" {
  source = "../../modules/auth"

  name = local.name
  # The hosted UI refuses any redirect_uri it was not told about, so the CloudFront origin
  # has to be registered here or sign-in works locally and fails on the deployed site.
  allowed_web_origins = local.web_origins
  threat_protection   = var.cognito_threat_protection
}

# Optional: off, every function runs as before and logs one line saying so.
module "guardrail" {
  source = "../../modules/guardrail"
  count  = var.guardrail_enabled ? 1 : 0

  name        = local.name
  kms_key_arn = module.security.data_key_arn
}

locals {
  # Empty strings when disabled: the functions read an empty GUARDRAIL_ID as off.
  guardrail = {
    id      = var.guardrail_enabled ? module.guardrail[0].guardrail_id : ""
    version = var.guardrail_enabled ? module.guardrail[0].guardrail_version : ""
    arn     = var.guardrail_enabled ? module.guardrail[0].guardrail_arn : ""
  }
}

module "pipeline" {
  source = "../../modules/pipeline"

  name       = local.name
  account_id = data.aws_caller_identity.current.account_id

  table_name           = module.storage.table_name
  table_arn            = module.storage.table_arn
  artifacts_bucket     = module.storage.artifacts_bucket
  artifacts_arn        = module.storage.artifacts_bucket_arn
  data_key_arn         = module.security.data_key_arn
  logs_key_arn         = module.security.logs_key_arn
  reserved_concurrency = var.pipeline_reserved_concurrency
  log_retention_days   = var.log_retention_days

  image_model         = var.image_model
  image_size          = var.image_size
  image_quality       = var.image_quality
  analyser_model      = var.analyser_model
  evaluation_model    = var.evaluation_model
  attempt_budget      = var.attempt_budget
  review_timeout_days = var.review_timeout_days

  litellm_base_url           = var.litellm_base_url
  litellm_api_key_secret_arn = var.litellm_api_key_secret_arn

  openai_api_key_secret_arn = var.openai_api_key_secret_arn
  openai_organization       = var.openai_organization
  openai_project            = var.openai_project

  guardrail_id      = local.guardrail.id
  guardrail_version = local.guardrail.version
  guardrail_arn     = local.guardrail.arn
}

module "api" {
  source = "../../modules/api"

  name = local.name

  table_name       = module.storage.table_name
  table_arn        = module.storage.table_arn
  artifacts_bucket = module.storage.artifacts_bucket
  artifacts_arn    = module.storage.artifacts_bucket_arn
  data_key_arn     = module.security.data_key_arn
  logs_key_arn     = module.security.logs_key_arn

  user_pool_endpoint = module.auth.user_pool_endpoint
  user_pool_client   = module.auth.user_pool_client_id

  # The API starts the pipeline and resolves its review gate, so it needs the alias ARN (durable
  # invokes must be qualified) and the unqualified function ARN for the callback permissions.
  # Both are built from the pipeline module's naming (`<name>-pipeline`, alias `live`) rather than
  # read from its outputs: an output reference adds the pipeline function and its alias to every
  # plan that touches the API, however narrowly the plan is targeted. `local.pipeline_function_arn`
  # is checked against the module's real ARN by the `pipeline_arn_matches` check below.
  pipeline_alias_arn    = "${local.pipeline_function_arn}:live"
  pipeline_function_arn = local.pipeline_function_arn

  # Not local.web_origins: the distribution depends on this API, and same-origin needs no CORS.
  allowed_web_origins  = var.allowed_web_origins
  origin_secret_slot   = var.origin_secret_slot
  reserved_concurrency = var.api_reserved_concurrency
  log_retention_days   = var.log_retention_days
  attempt_budget       = var.attempt_budget
  image_model          = var.image_model
  image_size           = var.image_size
  image_quality        = var.image_quality

  guardrail_id      = local.guardrail.id
  guardrail_version = local.guardrail.version
  guardrail_arn     = local.guardrail.arn
}

# The API gets the pipeline's ARNs by naming convention (see local.pipeline_function_arn). If the
# pipeline module ever renames its function, the API would invoke a function that does not exist;
# this warns at plan time. A `check` reads the module without adding it to the API's dependencies.
check "pipeline_arn_matches" {
  assert {
    condition     = local.pipeline_function_arn == module.pipeline.function_arn
    error_message = "modules/pipeline no longer names its function \"$${local.name}-pipeline\"; update local.pipeline_function_arn in envs/dev/main.tf so the API invokes the right function."
  }
}

module "web" {
  source = "../../modules/web"

  name       = local.name
  account_id = data.aws_caller_identity.current.account_id
  region     = var.region

  web_acl_arn           = module.security.cloudfront_web_acl_arn
  logs_bucket           = module.storage.logs_bucket
  logs_bucket_arn       = module.storage.logs_bucket_arn
  logs_bucket_policy_id = module.storage.logs_bucket_policy_id

  artifacts_bucket    = module.storage.artifacts_bucket
  domain_name         = var.web_domain_name
  acm_certificate_arn = var.web_acm_certificate_arn

  # Not local.web_origins, which depends on this module.
  allowed_web_origins = var.allowed_web_origins

  # /api/* on this distribution, behind its WAF web ACL.
  api_origin_domain = module.api.api_origin_domain
  api_origin_secret = module.api.origin_secret

  # The API is 'self'. A wildcard for Cognito: its callback URLs depend on this distribution.
  csp_connect_sources = [
    "https://*.auth.${var.region}.amazoncognito.com",
  ]
}
