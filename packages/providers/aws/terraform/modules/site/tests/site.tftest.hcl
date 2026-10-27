# Plans and applies the module against mocked AWS providers, so no AWS
# account is needed. Run with `tofu test` (or `terraform test`).

mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::sforge-docs-staging-abc"
      id                          = "sforge-docs-staging-abc"
      bucket_regional_domain_name = "sforge-docs-staging-abc.s3.eu-central-1.amazonaws.com"
      bucket_domain_name          = "sforge-docs-staging-abc.s3.amazonaws.com"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE"
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }
  mock_resource "aws_cloudfront_key_value_store" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:key-value-store/0e9c0a4e-0000-0000-0000-000000000000"
    }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/sforge-docs-staging-router"
    }
  }
  mock_resource "aws_lambda_function_url" {
    defaults = {
      function_url = "https://abcdefghij.lambda-url.eu-central-1.on.aws/"
    }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id       = "eu-central-1_AbCdEf123"
      endpoint = "cognito-idp.eu-central-1.amazonaws.com/eu-central-1_AbCdEf123"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/sforge-docs-staging-auth"
    }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn = "arn:aws:ssm:eu-central-1:123456789012:parameter/sforge/docs-staging/auth/key"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/sforge-docs-staging-auth"
    }
  }
  mock_data "aws_region" {
    defaults = {
      region = "eu-central-1"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }
}

mock_provider "archive" {}

mock_provider "aws" {
  alias = "us_east_1"
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
    }
  }
}

variables {
  name   = "docs"
  target = "staging"
}

run "private_bucket_behind_cloudfront" {
  command = apply

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.site.block_public_acls,
      aws_s3_bucket_public_access_block.site.block_public_policy,
      aws_s3_bucket_public_access_block.site.ignore_public_acls,
      aws_s3_bucket_public_access_block.site.restrict_public_buckets,
    ])
    error_message = "Block Public Access must be fully enabled on the content bucket."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.site.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled on the content bucket."
  }

  assert {
    condition     = aws_s3_bucket_versioning.site.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning must be enabled."
  }

  assert {
    condition     = startswith(aws_s3_bucket.site.bucket_prefix, "sforge-docs-staging-")
    error_message = "The bucket name must identify the site and target."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_s3_bucket_policy.site.policy).Statement :
      statement.Effect == "Deny" || (
        statement.Principal == { Service = "cloudfront.amazonaws.com" } &&
        statement.Condition.StringEquals["AWS:SourceArn"] == aws_cloudfront_distribution.site.arn
      )
    ])
    error_message = "Only this distribution may read the bucket."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(aws_s3_bucket_policy.site.policy).Statement :
      statement.Effect == "Deny" && try(statement.Condition.Bool["aws:SecureTransport"], "") == "false"
    ])
    error_message = "The bucket policy must deny requests without TLS."
  }

  assert {
    condition = (
      aws_cloudfront_origin_access_control.site.signing_behavior == "always" &&
      aws_cloudfront_origin_access_control.site.signing_protocol == "sigv4" &&
      one(aws_cloudfront_distribution.site.origin).origin_access_control_id == aws_cloudfront_origin_access_control.site.id
    )
    error_message = "The origin must use Origin Access Control with SigV4."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.default_cache_behavior).viewer_protocol_policy == "redirect-to-https"
    error_message = "HTTP must redirect to HTTPS."
  }

  assert {
    condition     = one(one(aws_cloudfront_distribution.site.default_cache_behavior).function_association).event_type == "viewer-request"
    error_message = "The router must run on viewer requests."
  }

  assert {
    condition     = aws_cloudfront_function.router.runtime == "cloudfront-js-2.0" && length(aws_cloudfront_function.router.key_value_store_associations) == 1
    error_message = "The router must use cloudfront-js-2.0 with the KeyValueStore."
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.router.code, "{\"auth\":null,\"previewSuffix\":\"\",\"trailingSlash\":\"always\"}") && !strcontains(aws_cloudfront_function.router.code, "__SFORGE_CONFIG__")
    error_message = "The router config must be substituted."
  }

  assert {
    condition     = length(aws_cloudfront_function.router.code) <= 10240 && !strcontains(aws_cloudfront_function.router.code, "\n// ")
    error_message = "Comment lines are removed and the router fits the 10 KB limit of CloudFront Functions."
  }

  assert {
    condition     = length(aws_cognito_user_pool.site) == 0 && length(aws_lambda_function.auth) == 0 && length(aws_cloudfront_distribution.site.ordered_cache_behavior) == 0 && output.sign_in_url == null
    error_message = "Public sites have no sign-in."
  }

  assert {
    condition     = aws_cloudfrontkeyvaluestore_key.active.key == "active"
    error_message = "The active version key must be seeded."
  }

  assert {
    condition     = toset([for r in aws_cloudfront_distribution.site.custom_error_response : r.response_page_path]) == toset(["/_sforge/errors/404.html"])
    error_message = "Missing objects must serve the 404 page."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.viewer_certificate).cloudfront_default_certificate
    error_message = "Without a domain the default certificate is used."
  }

  assert {
    condition     = length(aws_acm_certificate.site) == 0 && length(aws_iam_role.ci) == 0 && length(aws_s3_bucket.logs) == 0
    error_message = "Optional resources must not be created by default."
  }

  assert {
    condition     = output.url == "https://d111111abcdef8.cloudfront.net"
    error_message = "The URL must be the CloudFront domain."
  }
}

run "security_headers" {
  command = plan

  variables {
    security_headers = {
      content_security_policy        = "default-src 'self'"
      search_content_security_policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"
      hsts_max_age                   = 63072000
      permissions_policy             = "camera=()"
    }
    search_paths = ["/search", "/search/*"]
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.site["default"].security_headers_config).content_security_policy).content_security_policy == "default-src 'self'"
    error_message = "The CSP must be set."
  }

  assert {
    condition     = strcontains(one(one(aws_cloudfront_response_headers_policy.site["search"].security_headers_config).content_security_policy).content_security_policy, "'wasm-unsafe-eval'")
    error_message = "The search page must allow WebAssembly."
  }

  assert {
    condition     = one(one(aws_cloudfront_response_headers_policy.site["default"].security_headers_config).strict_transport_security).access_control_max_age_sec == 63072000
    error_message = "HSTS must be set."
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.path_pattern] == ["/search", "/search/*"]
    error_message = "The search paths must get their own behaviour."
  }
}

run "custom_domain_with_route53_and_previews" {
  command = apply

  override_data {
    target = data.aws_route53_zone.site[0]
    values = {
      zone_id = "Z123EXAMPLE"
    }
  }

  override_resource {
    target = aws_acm_certificate.site[0]
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
      domain_validation_options = [
        {
          domain_name           = "www.example.com"
          resource_record_name  = "_a1.www.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b1.acm-validations.aws."
        },
        {
          domain_name           = "*.preview.example.com"
          resource_record_name  = "_a2.preview.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b2.acm-validations.aws."
        },
      ]
    }
  }

  variables {
    domain         = "www.example.com"
    hosted_zone    = "example.com"
    preview_domain = "preview.example.com"
    trailing_slash = "never"
  }

  assert {
    condition     = toset(aws_cloudfront_distribution.site.aliases) == toset(["www.example.com", "*.preview.example.com"])
    error_message = "The domain and preview wildcard must be aliases."
  }

  assert {
    condition     = aws_acm_certificate.site[0].domain_name == "www.example.com" && toset(aws_acm_certificate.site[0].subject_alternative_names) == toset(["*.preview.example.com"])
    error_message = "The certificate must cover the domain and previews."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.viewer_certificate).minimum_protocol_version == "TLSv1.2_2021"
    error_message = "Custom domains must require TLS 1.2."
  }

  assert {
    condition     = toset([for r in aws_route53_record.validation : r.name]) == toset(["_a1.www.example.com.", "_a2.preview.example.com."])
    error_message = "Route 53 must hold the certificate's validation records."
  }

  assert {
    condition     = length(aws_route53_record.alias) == 4
    error_message = "A and AAAA aliases are needed for the domain and the preview wildcard."
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.router.code, "\"previewSuffix\":\".preview.example.com\"") && strcontains(aws_cloudfront_function.router.code, "\"trailingSlash\":\"never\"")
    error_message = "The router must know the preview suffix and trailing slash mode."
  }

  assert {
    condition     = output.url == "https://www.example.com"
    error_message = "The URL must use the custom domain."
  }
}

run "custom_domain_with_external_dns" {
  command = apply

  override_resource {
    target = aws_acm_certificate.site[0]
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
      domain_validation_options = [
        {
          domain_name           = "docs.example.com"
          resource_record_name  = "_a1.docs.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b1.acm-validations.aws."
        },
        {
          domain_name           = "*.preview.example.com"
          resource_record_name  = "_a2.preview.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b2.acm-validations.aws."
        },
      ]
    }
  }

  variables {
    domain                  = "docs.example.com"
    preview_domain          = "preview.example.com"
    validation_record_fqdns = ["_a1.docs.example.com", "_a2.preview.example.com"]
  }

  assert {
    condition     = length(aws_route53_record.validation) == 0 && length(aws_route53_record.alias) == 0
    error_message = "Without a hosted zone, Route 53 holds nothing."
  }

  assert {
    condition     = toset(aws_acm_certificate_validation.site[0].validation_record_fqdns) == toset(["_a1.docs.example.com", "_a2.preview.example.com"])
    error_message = "The validation must wait for the records created outside the module."
  }

  assert {
    condition = output.dns_validation_records == {
      "docs.example.com"    = { name = "_a1.docs.example.com.", type = "CNAME", value = "_b1.acm-validations.aws." }
      "preview.example.com" = { name = "_a2.preview.example.com.", type = "CNAME", value = "_b2.acm-validations.aws." }
    }
    error_message = "The validation records must be keyed by certificate name."
  }

  assert {
    condition = output.dns_routing_records == {
      "docs.example.com"      = { name = "docs.example.com", type = "CNAME", value = "d111111abcdef8.cloudfront.net" }
      "*.preview.example.com" = { name = "*.preview.example.com", type = "CNAME", value = "d111111abcdef8.cloudfront.net" }
    }
    error_message = "The domain and the preview wildcard must point at CloudFront."
  }
}

run "previews_under_the_domain_share_its_validation_record" {
  command = apply

  override_resource {
    target = aws_acm_certificate.site[0]
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
      domain_validation_options = [
        {
          domain_name           = "docs.example.com"
          resource_record_name  = "_a1.docs.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b1.acm-validations.aws."
        },
        {
          domain_name           = "*.docs.example.com"
          resource_record_name  = "_a1.docs.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b1.acm-validations.aws."
        },
      ]
    }
  }

  variables {
    domain                  = "docs.example.com"
    preview_domain          = "docs.example.com"
    validation_record_fqdns = ["_a1.docs.example.com"]
  }

  assert {
    condition     = keys(output.dns_validation_records) == ["docs.example.com"]
    error_message = "One validation record serves the domain and its wildcard."
  }
}

run "ci_role_pinned_to_repo" {
  command = apply

  variables {
    ci = {
      repo                 = "acme/docs"
      subject_prefix       = "repo:acme@1001/docs@2002"
      branches             = ["main"]
      environments         = ["staging"]
      pull_requests        = true
      create_oidc_provider = true
      state_bucket         = "sforge-state-123456789012-eu-central-1"
      state_key            = "docs/staging.tfstate"
    }
  }

  assert {
    condition = jsondecode(aws_iam_role.ci[0].assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] == [
      "repo:acme@1001/docs@2002:ref:refs/heads/main",
      "repo:acme@1001/docs@2002:environment:staging",
      "repo:acme@1001/docs@2002:pull_request",
    ]
    error_message = "The trust policy must be pinned to the repository's branches, environments and PRs."
  }

  assert {
    condition     = jsondecode(aws_iam_role.ci[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "The audience must be STS."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.ci[0].policy).Statement :
      !contains(flatten([statement.Resource]), "*") && !contains(flatten([statement.Action]), "s3:*")
    ])
    error_message = "The deploy role must not use wildcards."
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.ci[0].policy).Statement : s.Resource]), "arn:aws:s3:::sforge-state-123456789012-eu-central-1/docs/staging.tfstate")
    error_message = "The role must reach its own state key."
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1
    error_message = "The OIDC provider must be created when the account has none."
  }
}

run "ci_role_reusing_provider_without_state" {
  command = plan

  variables {
    ci = {
      repo                 = "acme/docs"
      subject_prefix       = "repo:acme/docs"
      branches             = ["main"]
      environments         = []
      pull_requests        = false
      create_oidc_provider = false
      oidc_provider_arn    = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "An existing OIDC provider must be reused."
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.ci[0].policy).Statement) == 4
    error_message = "Without a state bucket the role gets no state access."
  }
}

run "access_logs" {
  command = plan

  variables {
    logging = true
  }

  assert {
    condition     = length(aws_s3_bucket.logs) == 1 && aws_s3_bucket_public_access_block.logs[0].block_public_policy
    error_message = "Logging must create a private log bucket."
  }
}

run "private_site_without_domain" {
  command = apply

  variables {
    site_title = "Docs"
    auth       = {}
  }

  assert {
    condition     = aws_cognito_user_pool.site[0].admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_pool.site[0].user_pool_tier == "ESSENTIALS"
    error_message = "Only administrators create users (Essentials tier)."
  }

  assert {
    condition     = aws_cognito_user_pool.site[0].mfa_configuration == "OPTIONAL" && aws_cognito_user_pool.site[0].software_token_mfa_configuration[0].enabled
    error_message = "TOTP MFA is optional by default."
  }

  assert {
    condition     = strcontains(aws_cognito_user_pool.site[0].admin_create_user_config[0].invite_message_template[0].email_subject, "Docs")
    error_message = "Invitations name the site."
  }

  assert {
    condition = (
      !aws_cognito_user_pool_client.site[0].generate_secret &&
      aws_cognito_user_pool_client.site[0].allowed_oauth_flows == toset(["code"]) &&
      aws_cognito_user_pool_client.site[0].callback_urls == toset(["https://d111111abcdef8.cloudfront.net/_sforge/auth/callback"])
    )
    error_message = "A public code-flow client calls back to the CloudFront host without a domain."
  }

  assert {
    condition     = aws_cognito_user_pool_domain.site[0].managed_login_version == 2 && !strcontains(aws_cognito_user_pool_domain.site[0].domain, "aws")
    error_message = "Managed login v2 on a valid prefix domain."
  }

  assert {
    condition     = aws_lambda_function.auth[0].runtime == "nodejs24.x" && one(aws_lambda_function.auth[0].architectures) == "arm64" && aws_lambda_function.auth[0].memory_size == 128
    error_message = "The sign-in Lambda is a small arm64 Node.js function."
  }

  assert {
    condition     = aws_lambda_function_url.auth[0].authorization_type == "AWS_IAM" && aws_cloudfront_origin_access_control.auth[0].origin_access_control_origin_type == "lambda"
    error_message = "The function URL is reachable only through CloudFront's origin access control."
  }

  assert {
    condition     = aws_lambda_permission.auth_url[0].source_arn == aws_cloudfront_distribution.site.arn && aws_lambda_permission.auth_invoke[0].source_arn == aws_cloudfront_distribution.site.arn
    error_message = "Only this distribution may invoke the Lambda."
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.path_pattern] == ["/_sforge/auth/*"] && aws_cloudfront_distribution.site.ordered_cache_behavior[0].target_origin_id == "auth"
    error_message = "/_sforge/auth/* goes to the Lambda."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.auth[0].policy).Statement : !contains(flatten([s.Resource]), "*")
    ])
    error_message = "The Lambda's role reaches only its parameters and log group."
  }

  assert {
    condition     = aws_ssm_parameter.auth_key[0].type == "SecureString" && aws_ssm_parameter.auth_key[0].value == "none" && aws_cloudfrontkeyvaluestore_key.auth[0].value == "none"
    error_message = "The session key is only seeded; sforge writes it after the apply."
  }

  assert {
    condition = jsondecode(aws_ssm_parameter.auth_config[0].value) == {
      clientId      = aws_cognito_user_pool_client.site[0].id
      cognitoDomain = "https://${aws_cognito_user_pool_domain.site[0].domain}.auth.eu-central-1.amazoncognito.com"
      issuer        = "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_AbCdEf123"
      hosts         = ["d111111abcdef8.cloudfront.net"]
      previewSuffix = ""
      sessionHours  = 8
    }
    error_message = "The Lambda's settings name the client, the Cognito domain, the issuer and the hosts."
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.router.code, "\"auth\":{\"canonicalHost\":\"\",\"loginHost\":\"\"}") && length(aws_cloudfront_function.router.code) <= 10240
    error_message = "Without a domain, every host signs in itself."
  }

  assert {
    condition     = output.sign_in_url == "https://d111111abcdef8.cloudfront.net/_sforge/auth/login" && output.auth_user_pool_id == "eu-central-1_AbCdEf123"
    error_message = "The sign-in URL and the user pool are outputs."
  }
}

run "private_site_on_a_private_domain" {
  command = apply

  override_resource {
    target = aws_acm_certificate.site[0]
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
      domain_validation_options = [
        {
          domain_name           = "intra.example.com"
          resource_record_name  = "_a1.intra.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b1.acm-validations.aws."
        },
        {
          domain_name           = "*.preview.example.com"
          resource_record_name  = "_a2.preview.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_b2.acm-validations.aws."
        },
      ]
    }
  }

  override_data {
    target = data.aws_route53_zone.site[0]
    values = {
      zone_id = "Z123EXAMPLE"
    }
  }

  variables {
    domain         = "intra.example.com"
    hosted_zone    = "example.com"
    preview_domain = "preview.example.com"
    private_dns    = true
    auth           = { mfa = "required", session_hours = 4 }
  }

  assert {
    condition     = length(aws_route53_record.validation) == 2 && length(aws_route53_record.alias) == 0
    error_message = "Only validation records go to the public zone."
  }

  assert {
    condition     = length(output.dns_records) == 0 && length(output.dns_routing_records) == 0
    error_message = "No routing records are published."
  }

  assert {
    condition = jsonencode(output.dns_private_records) == jsonencode([
      { name = "intra.example.com", type = "CNAME", value = "d111111abcdef8.cloudfront.net" },
      { name = "*.preview.example.com", type = "CNAME", value = "d111111abcdef8.cloudfront.net" },
    ])
    error_message = "The routing records are listed for the internal DNS."
  }

  assert {
    condition     = aws_cognito_user_pool.site[0].mfa_configuration == "ON"
    error_message = "MFA can be required."
  }

  assert {
    condition     = aws_cognito_user_pool_client.site[0].callback_urls == toset(["https://intra.example.com/_sforge/auth/callback"])
    error_message = "Only the domain signs in; previews hand over from it."
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.router.code, "\"auth\":{\"canonicalHost\":\"intra.example.com\",\"loginHost\":\"intra.example.com\"}")
    error_message = "The CloudFront host redirects to the domain, where users sign in."
  }

  assert {
    condition     = jsondecode(aws_ssm_parameter.auth_config[0].value).previewSuffix == ".preview.example.com" && jsondecode(aws_ssm_parameter.auth_config[0].value).sessionHours == 4
    error_message = "The Lambda knows the previews and the session length."
  }
}

run "private_site_also_on_the_cloudfront_host" {
  command = plan

  override_resource {
    target = aws_acm_certificate.site[0]
    values = {
      arn                       = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
      domain_validation_options = [{ domain_name = "intra.example.com", resource_record_name = "_a1.intra.example.com.", resource_record_type = "CNAME", resource_record_value = "_b1.acm-validations.aws." }]
    }
  }

  variables {
    domain                  = "intra.example.com"
    validation_record_fqdns = ["_a1.intra.example.com"]
    auth                    = { allow_cloudfront_host = true, mfa = "off" }
  }

  assert {
    condition     = aws_cognito_user_pool.site[0].mfa_configuration == "OFF" && length(aws_cognito_user_pool.site[0].software_token_mfa_configuration) == 0
    error_message = "MFA can be turned off."
  }
}

run "rejects_bad_auth_settings" {
  command = plan

  variables {
    auth = { mfa = "sms", session_hours = 48 }
  }

  expect_failures = [var.auth]
}
