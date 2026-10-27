# Private sites (var.auth): every URL requires signing in. Users live in a
# Cognito user pool (Essentials tier, created by an administrator only, signed
# in through managed login). The router function checks a signed session
# cookie on every request; this small regional Lambda runs only while someone
# signs in, behind CloudFront at /_sforge/auth/* (a function URL with IAM auth,
# reachable only through the distribution's origin access control).
#
# The cookie key is never in state: it is seeded "none" here and replaced by
# sforge after the apply (KVS "auth:key" for the router, an SSM SecureString
# for the Lambda). The Lambda reads its settings from a second parameter, so
# it does not depend on the user pool client, whose callback URLs need the
# distribution, which needs the Lambda.

locals {
  auth = var.auth != null
  # Hosts that sign in themselves (callback URLs); previews hand over from the first.
  auth_hosts = !local.auth ? [] : (
    local.custom_domain
    ? concat([var.domain], var.auth.allow_cloudfront_host ? [aws_cloudfront_distribution.site.domain_name] : [])
    : [aws_cloudfront_distribution.site.domain_name]
  )
  auth_function_name    = substr("sforge-${local.id}-auth", 0, 64)
  auth_config_parameter = "/sforge/${local.id}/auth/config"
  auth_key_parameter    = "/sforge/${local.id}/auth/key"
  mfa_configuration     = { off = "OFF", optional = "OPTIONAL", required = "ON" }
  # Where users sign in; invitations name it.
  auth_login_host = local.custom_domain ? var.domain : aws_cloudfront_distribution.site.domain_name
  site_label      = var.site_title == null ? local.auth_login_host : var.site_title
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_cognito_user_pool" "site" {
  count = local.auth ? 1 : 0

  name                     = substr("sforge-${local.id}", 0, 128)
  user_pool_tier           = "ESSENTIALS"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  # sforge destroy removes the pool with the rest of the site.
  deletion_protection = "INACTIVE"
  mfa_configuration   = local.mfa_configuration[var.auth.mfa]
  tags                = local.tags

  dynamic "software_token_mfa_configuration" {
    for_each = var.auth.mfa == "off" ? [] : [1]
    content {
      enabled = true
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # No self sign-up: `sforge users invite` creates users, and Cognito emails
  # them a temporary password.
  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "Your access to ${local.site_label}"
      email_message = "You can now sign in to ${local.site_label} at https://${local.auth_login_host}/ with the user name {username} and the temporary password {####}. You will choose your own password when you first sign in."
      sms_message   = "Sign in to ${local.site_label} as {username} with the temporary password {####}."
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
}

# A prefix domain: <prefix>.auth.<region>.amazoncognito.com. Prefixes are
# unique per region and may not contain "aws", "amazon" or "cognito", so it is
# derived from the content bucket's (random) name.
resource "aws_cognito_user_pool_domain" "site" {
  count = local.auth ? 1 : 0

  domain                = "sforge-${substr(sha256(aws_s3_bucket.site.id), 0, 16)}"
  user_pool_id          = aws_cognito_user_pool.site[0].id
  managed_login_version = 2
}

resource "aws_cognito_user_pool_client" "site" {
  count = local.auth ? 1 : 0

  name         = substr("sforge-${local.id}", 0, 128)
  user_pool_id = aws_cognito_user_pool.site[0].id
  # A public client: the Lambda proves the code exchange with PKCE.
  generate_secret                      = false
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [for host in local.auth_hosts : "https://${host}/_sforge/auth/callback"]
  logout_urls                          = [for host in local.auth_hosts : "https://${host}/"]
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  # The ID token is used once, to issue the session cookie.
  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 1
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_managed_login_branding" "site" {
  count = local.auth ? 1 : 0

  user_pool_id                = aws_cognito_user_pool.site[0].id
  client_id                   = aws_cognito_user_pool_client.site[0].id
  use_cognito_provided_values = true
}

resource "aws_ssm_parameter" "auth_config" {
  count = local.auth ? 1 : 0

  name        = local.auth_config_parameter
  description = "staticforge ${local.id}: sign-in settings"
  type        = "String"
  tags        = local.tags
  value = jsonencode({
    clientId      = aws_cognito_user_pool_client.site[0].id
    cognitoDomain = "https://${aws_cognito_user_pool_domain.site[0].domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
    issuer        = "https://${aws_cognito_user_pool.site[0].endpoint}"
    hosts         = local.auth_hosts
    previewSuffix = var.preview_domain == null ? "" : ".${var.preview_domain}"
    sessionHours  = var.auth.session_hours
  })
}

# Seeded once; sforge writes the real key after the apply and on
# `sforge users revoke-sessions`.
resource "aws_ssm_parameter" "auth_key" {
  count = local.auth ? 1 : 0

  name        = local.auth_key_parameter
  description = "staticforge ${local.id}: session cookie key (set by sforge)"
  type        = "SecureString"
  value       = "none"
  tags        = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_cloudfrontkeyvaluestore_key" "auth" {
  count = local.auth ? 1 : 0

  key_value_store_arn = aws_cloudfront_key_value_store.site.arn
  key                 = "auth:key"
  value               = "none"

  lifecycle {
    ignore_changes = [value]
  }
}

data "archive_file" "auth" {
  count = local.auth ? 1 : 0

  type        = "zip"
  source_file = "${path.module}/auth-lambda/index.mjs"
  output_path = "${path.root}/.sforge-auth-lambda.zip"
}

resource "aws_iam_role" "auth" {
  count = local.auth ? 1 : 0

  name        = substr("sforge-${local.id}-auth", 0, 64)
  description = "staticforge: sign-in Lambda of ${local.id}"
  tags        = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_cloudwatch_log_group" "auth" {
  count = local.auth ? 1 : 0

  name              = "/aws/lambda/${local.auth_function_name}"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_iam_role_policy" "auth" {
  count = local.auth ? 1 : 0

  name = "sign-in"
  role = aws_iam_role.auth[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadSettingsAndKey"
        Effect = "Allow"
        Action = "ssm:GetParameter"
        # SecureStrings use the aws/ssm key, which every principal of the account may use through SSM.
        Resource = [aws_ssm_parameter.auth_config[0].arn, aws_ssm_parameter.auth_key[0].arn]
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.auth[0].arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "auth" {
  count = local.auth ? 1 : 0

  function_name    = local.auth_function_name
  description      = "staticforge sign-in for ${local.id}"
  role             = aws_iam_role.auth[0].arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 10
  handler          = "index.handler"
  filename         = data.archive_file.auth[0].output_path
  source_code_hash = data.archive_file.auth[0].output_base64sha256
  tags             = local.tags

  environment {
    variables = {
      SFORGE_CONFIG_PARAMETER = local.auth_config_parameter
      SFORGE_KEY_PARAMETER    = local.auth_key_parameter
    }
  }

  depends_on = [aws_cloudwatch_log_group.auth]
}

resource "aws_lambda_function_url" "auth" {
  count = local.auth ? 1 : 0

  function_name      = aws_lambda_function.auth[0].function_name
  authorization_type = "AWS_IAM"
}

resource "aws_cloudfront_origin_access_control" "auth" {
  count = local.auth ? 1 : 0

  name                              = substr("sforge-${local.id}-auth", 0, 64)
  description                       = "staticforge ${local.id} sign-in"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Function URLs need both permissions for callers other than the owner.
resource "aws_lambda_permission" "auth_url" {
  count = local.auth ? 1 : 0

  statement_id           = "CloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.auth[0].function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "auth_invoke" {
  count = local.auth ? 1 : 0

  statement_id  = "CloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth[0].function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}

data "aws_cloudfront_cache_policy" "disabled" {
  count = local.auth ? 1 : 0
  name  = "Managed-CachingDisabled"
}

# Cookies, query strings and the router's x-sforge-host, but not Host: the
# function URL must see its own host name.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  count = local.auth ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}
