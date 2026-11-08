/**
 * One Bedrock guardrail screening every free-text input before a model reads it: content
 * filters (hate, insults, sexual, violence, misconduct) and the prompt-attack filter, on text
 * only. The pipeline applies it on its Converse calls (`guardrailConfig` with the user text in
 * `guardContent`) and with ApplyGuardrail on text bound for the image model; the API applies it
 * to review notes. A block is terminal and names the policy, never the text.
 *
 * Classic tier: the Standard tier requires a cross-Region guardrail profile, which would let
 * the screened text be processed in other Regions.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-content-filters.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-prompt-attack.html
 */

locals {
  # Medium blocks medium- and high-confidence detections. Product details and notes are full of
  # imperatives ("make the handle longer"), so a High prompt-attack strength would block
  # ordinary requests more often.
  content_filters = ["HATE", "INSULTS", "SEXUAL", "VIOLENCE", "MISCONDUCT"]
}

resource "aws_bedrock_guardrail" "this" {
  name        = "${var.name}-inputs"
  description = "Screens product details, file names, design and review notes and per-view requests."

  # Shown nowhere: the pipeline reports the policy that blocked, not this text.
  blocked_input_messaging   = "This input was blocked by the content guardrail."
  blocked_outputs_messaging = "This answer was blocked by the content guardrail."

  # The account's data key; Bedrock uses the creator's grant to encrypt the guardrail at rest.
  # https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-kms.html
  kms_key_arn = var.kms_key_arn

  content_policy_config {
    dynamic "filters_config" {
      for_each = local.content_filters
      content {
        type              = filters_config.value
        input_strength    = "MEDIUM"
        input_action      = "BLOCK"
        input_enabled     = true
        input_modalities  = ["TEXT"]
        output_strength   = "MEDIUM"
        output_action     = "BLOCK"
        output_enabled    = true
        output_modalities = ["TEXT"]
      }
    }

    # Input only: the filter applies to prompts, so its output strength is NONE.
    filters_config {
      type             = "PROMPT_ATTACK"
      input_strength   = "MEDIUM"
      input_action     = "BLOCK"
      input_enabled    = true
      input_modalities = ["TEXT"]
      output_strength  = "NONE"
    }

    tier_config {
      tier_name = "CLASSIC"
    }
  }
}

# A numbered version: the functions pin it, so editing the guardrail changes nothing in flight
# until the next apply publishes a new one. Old versions are kept for runs that started on them.
resource "aws_bedrock_guardrail_version" "this" {
  guardrail_arn = aws_bedrock_guardrail.this.guardrail_arn
  description   = "Published by Terraform."
  skip_destroy  = true

  lifecycle {
    replace_triggered_by = [aws_bedrock_guardrail.this]
  }
}
