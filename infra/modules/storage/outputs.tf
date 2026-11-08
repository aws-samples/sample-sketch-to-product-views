output "table_name" {
  description = "Single DynamoDB table holding revisions, stage events and the model registry."
  value       = aws_dynamodb_table.main.name
}

output "table_arn" {
  description = "ARN of that table, for scoping consumer IAM policies."
  value       = aws_dynamodb_table.main.arn
}

output "artifacts_bucket" {
  description = "Bucket holding sketches, candidates and delivered assets."
  value       = aws_s3_bucket.artifacts.id
}

output "artifacts_bucket_arn" {
  description = "ARN of the artifacts bucket, for scoping consumer IAM policies."
  value       = aws_s3_bucket.artifacts.arn
}

output "logs_bucket" {
  description = "Bucket receiving S3 and CloudFront access logs."
  value       = aws_s3_bucket.logs.id
}

output "logs_bucket_arn" {
  description = "Destination of the CloudFront logging v2 delivery."
  value       = aws_s3_bucket.logs.arn
}

output "logs_bucket_policy_id" {
  description = "Exists once the logs bucket policy admits log delivery; deliveries wait on it."
  value       = aws_s3_bucket_policy.logs.id
}
