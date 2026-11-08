output "alias_arn" {
  description = "Qualified ARN of the `live` alias. Durable invocations must be qualified, so this is what callers use."
  value       = aws_lambda_alias.live.arn
}

output "function_arn" {
  description = "Unqualified function ARN, used to scope callback permissions across all versions."
  value       = aws_lambda_function.pipeline.arn
}

output "dlq_url" {
  description = "Dead-letter queue receiving the submit event of a run that failed, timed out or was stopped outside the handler's own error handling."
  value       = aws_sqs_queue.dlq.url
}
