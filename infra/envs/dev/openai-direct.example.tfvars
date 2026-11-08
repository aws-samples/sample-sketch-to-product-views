# The default deployment: images from OpenAI's API with a project API key, the analyser and
# the critic on Bedrock.
# Copy to <config>.tfvars; infra/README.md covers the backend file.
#
# Data handling: api.openai.com has no region constraint, and OpenAI keeps abuse-monitoring logs
# for up to 30 days by default (https://developers.openai.com/api/docs/guides/your-data).

environment = "dev"

analyser_model = "analyser-sonnet-bedrock"
image_model    = "gpt-image-2.6-sunburst-openai"
# Every view is rendered at the registry's default size and quality (2336x3504, max). The
# fallback, cheaper and faster, is one of the entry's other options:
# image_size    = "1536x2304"
# image_quality = "high"
evaluation_model = "critic-sonnet"

# Required by the OpenAI image model. Replace the placeholder.
openai_api_key_secret_arn = "arn:aws:secretsmanager:us-east-1:<account-id>:secret:<name>" # pragma: allowlist secret

# Optional OpenAI-Organization / OpenAI-Project headers; empty sends none.
# openai_organization = "org-..."
# openai_project      = "proj_..."

# Leaving litellm_api_key_secret_arn unset keeps that secret permission off the pipeline role.
