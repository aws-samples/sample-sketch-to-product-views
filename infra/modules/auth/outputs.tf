output "user_pool_id" {
  description = "Cognito user pool backing the API authorizer."
  value       = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  description = "Public SPA app client id."
  value       = aws_cognito_user_pool_client.web.id
}

output "user_pool_endpoint" {
  description = "Issuer URL for the API Gateway JWT authorizer."
  value       = "https://${aws_cognito_user_pool.main.endpoint}"
}

output "hosted_ui_domain" {
  description = "Hosted-UI domain prefix; the full origin is assembled by the caller."
  value       = aws_cognito_user_pool_domain.main.domain
}
