output "distribution_domain" {
  description = "CloudFront domain serving the SPA."
  value       = aws_cloudfront_distribution.web.domain_name
}

output "distribution_id" {
  description = "Distribution to invalidate after syncing a new build."
  value       = aws_cloudfront_distribution.web.id
}

output "distribution_arn" {
  description = "ARN of the distribution."
  value       = aws_cloudfront_distribution.web.arn
}

output "bucket_name" {
  description = "Bucket the built SPA is synced into."
  value       = aws_s3_bucket.web.id
}

output "site_origin" {
  description = "Origin users open: the custom domain when set, else the distribution domain."
  value       = local.site_origin
}
