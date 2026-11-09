# An account that reaches the image model through a LiteLLM gateway, with a virtual key
# kept in Secrets Manager. Copy to <config>.tfvars and fill in the placeholders.

environment = "dev"

analyser_model   = "analyser-sonnet-bedrock"
image_model      = "gpt-image-flare"
evaluation_model = "critic-sonnet"

litellm_base_url = "https://litellm.example.internal"

# Required by the LiteLLM image model above.
litellm_api_key_secret_arn = "arn:aws:secretsmanager:us-east-1:<account-id>:secret:<name>" # pragma: allowlist secret
