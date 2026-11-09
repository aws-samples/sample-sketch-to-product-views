output "guardrail_id" {
  description = "Guardrail id, passed to the functions as GUARDRAIL_ID."
  value       = aws_bedrock_guardrail.this.guardrail_id
}

output "guardrail_arn" {
  description = "Guardrail ARN, the resource of bedrock:ApplyGuardrail."
  value       = aws_bedrock_guardrail.this.guardrail_arn
}

output "guardrail_version" {
  description = "Published version the functions pin, passed as GUARDRAIL_VERSION."
  value       = aws_bedrock_guardrail_version.this.version
}
