output "api_endpoint" {
  description = "The raw execute-api endpoint. Browsers cannot use it (no origin secret); it is CloudFront's origin."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_origin_domain" {
  description = "Host name of the execute-api endpoint, for the CloudFront origin."
  value       = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
}

output "origin_secret" {
  description = "The origin secret CloudFront sends as x-origin-verify."
  value       = random_password.origin_verify[var.origin_secret_slot].result
  sensitive   = true
}

output "user_data_role_arn" {
  description = "The role the API assumes per request with the caller's sub as a session tag; the only path to DynamoDB and S3."
  value       = aws_iam_role.user_data.arn
}
