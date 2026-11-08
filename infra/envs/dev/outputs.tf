output "api_url" {
  description = "Public API path: the site origin + /api, through CloudFront and AWS WAF."
  value       = "${module.web.site_origin}/api"
}

output "api_endpoint" {
  description = "Raw execute-api endpoint (CloudFront's origin). Refuses requests without the origin secret; for operators only."
  value       = module.api.api_endpoint
}

output "artifacts_bucket" {
  description = "Bucket holding sketches, generated candidates and delivered assets."
  value       = module.storage.artifacts_bucket
}

output "table_name" {
  description = "DynamoDB table holding revisions, stage events and the model registry."
  value       = module.storage.table_name
}

output "pipeline_alias_arn" {
  description = "Qualified ARN of the durable pipeline function. Durable invokes require a qualified ARN."
  value       = module.pipeline.alias_arn
}

output "user_pool_id" {
  description = "Cognito user pool backing the API's JWT authorizer."
  value       = module.auth.user_pool_id
}

output "user_pool_client_id" {
  description = "Cognito app client used by the SPA."
  value       = module.auth.user_pool_client_id
}

output "hosted_ui_url" {
  description = "Cognito hosted UI origin. The SPA redirects here for the PKCE code flow."
  value       = "https://${module.auth.hosted_ui_domain}.auth.${var.region}.amazoncognito.com"
}

output "web_url" {
  description = "The SPA, served by CloudFront."
  value       = module.web.site_origin
}

output "web_bucket" {
  description = "Bucket the SPA build is uploaded to."
  value       = module.web.bucket_name
}

output "web_distribution_id" {
  description = "CloudFront distribution to invalidate after an upload."
  value       = module.web.distribution_id
}

output "guardrail_id" {
  description = "Bedrock guardrail the functions screen free text with; empty when disabled."
  value       = local.guardrail.id
}

output "guardrail_version" {
  description = "Guardrail version the functions pin; empty when disabled."
  value       = local.guardrail.version
}

output "pipeline_dlq_url" {
  description = "Dead-letter queue of the pipeline function: events of runs that ended outside the handler's error handling."
  value       = module.pipeline.dlq_url
}
