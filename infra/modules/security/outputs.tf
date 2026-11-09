output "data_key_arn" {
  description = "CMK for S3, DynamoDB and SQS."
  value       = aws_kms_key.data.arn
}

output "logs_key_arn" {
  description = "CMK for CloudWatch log groups."
  value       = aws_kms_key.logs.arn
}

output "cloudfront_web_acl_arn" {
  description = "us-east-1 CLOUDFRONT-scoped web ACL."
  value       = aws_wafv2_web_acl.cloudfront.arn
}

output "waf_log_group_arn" {
  description = "us-east-1 log group the CloudFront web ACLs write their request logs to."
  value       = aws_cloudwatch_log_group.waf.arn
}
