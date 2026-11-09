/**
 * Cognito user pool backing the HTTP API's JWT authorizer. Designers are invited by
 * an administrator — there is no self-signup, because every account maps to a named
 * reviewer whose approval is recorded on the revision.
 */

resource "aws_cognito_user_pool" "main" {
  name                     = var.name
  deletion_protection      = "INACTIVE"
  mfa_configuration        = "OPTIONAL"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  software_token_mfa_configuration {
    enabled = true
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  # The human review gate records who approved a revision, so the reviewer's name must be a
  # first-class claim rather than something the client asserts.
  schema {
    name                     = "name"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 128
    }
  }

  # Threat protection needs the Plus feature plan; AUDIT or ENFORCED requires PLUS
  # (https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html).
  user_pool_tier = var.threat_protection == "OFF" ? "ESSENTIALS" : "PLUS"

  user_pool_add_ons {
    advanced_security_mode = var.threat_protection
  }
}

/**
 * Full-function responses (ENFORCED only). Adaptive authentication needs MFA set to OPTIONAL,
 * as above. No notification e-mails: they need an SES identity. Compromised-credentials checks
 * do not see SRP sign-ins, only passwords sent in plaintext (managed login, password change)
 * (https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html).
 */
resource "aws_cognito_risk_configuration" "main" {
  count = var.threat_protection == "ENFORCED" ? 1 : 0

  user_pool_id = aws_cognito_user_pool.main.id

  # Optional MFA challenges users who set up TOTP; Require MFA blocks those who did not
  # (https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-adaptive-authentication.html).
  account_takeover_risk_configuration {
    actions {
      low_action {
        event_action = "NO_ACTION"
        notify       = false
      }
      medium_action {
        event_action = "MFA_IF_CONFIGURED"
        notify       = false
      }
      high_action {
        event_action = "MFA_REQUIRED"
        notify       = false
      }
    }
  }

  # A blocked user is set to RESET_REQUIRED and must change the password.
  compromised_credentials_risk_configuration {
    event_filter = ["SIGN_IN", "PASSWORD_CHANGE", "SIGN_UP"]
    actions {
      event_action = "BLOCK"
    }
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.name
  user_pool_id = aws_cognito_user_pool.main.id
}

/**
 * Public SPA client: no secret (a browser cannot keep one), authorization code with
 * PKCE only, and implicit flow off.
 */
resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = var.allowed_web_origins
  logout_urls   = var.allowed_web_origins

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 8

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }

  prevent_user_existence_errors = "ENABLED"

  # AWS omits GenerateSecret when false, so import reads it as null vs this
  # file's `false` — a ForceNew diff that would replace the client otherwise.
  lifecycle {
    ignore_changes = [generate_secret]
  }
  enable_token_revocation = true
}
