output "bucket" {
  description = "Content bucket (private)."
  value       = aws_s3_bucket.site.id
}

output "bucket_region" {
  value = aws_s3_bucket.site.region
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.site.arn
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "kvs_arn" {
  description = "KeyValueStore with the active version, preview hosts and route exceptions."
  value       = aws_cloudfront_key_value_store.site.arn
}

output "url" {
  value = "https://${local.custom_domain ? var.domain : aws_cloudfront_distribution.site.domain_name}"
}

output "preview_domain" {
  value = var.preview_domain
}

output "trailing_slash" {
  value = var.trailing_slash
}

output "certificate_arn" {
  value = local.custom_domain ? aws_acm_certificate.site[0].arn : null
}

output "validation_records" {
  description = "DNS records that validate the certificate (create them when there is no hosted_zone)."
  value = local.custom_domain ? [
    for option in aws_acm_certificate.site[0].domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ] : []
}

output "dns_records" {
  description = "Records pointing the custom domain at CloudFront (created when hosted_zone is set). Empty with private_dns."
  value = var.private_dns ? [] : [for name in local.aliases : {
    name  = name
    type  = "CNAME"
    value = aws_cloudfront_distribution.site.domain_name
  }]
}

output "dns_validation_records" {
  description = "The validation records keyed by a name known when planning, for a DNS module to create."
  value = {
    for key, option in local.shared_validation : key => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  }
}

output "dns_routing_records" {
  description = "dns_records keyed by name, for a DNS module to create."
  value = {
    for name in(var.private_dns ? [] : local.aliases) : name => {
      name  = name
      type  = "CNAME"
      value = aws_cloudfront_distribution.site.domain_name
    }
  }
}

output "ci_role_arn" {
  value = local.ci == null ? null : aws_iam_role.ci[0].arn
}

output "oidc_provider_arn" {
  value = local.oidc_provider_arn
}

output "dns_private_records" {
  description = "With private_dns: the records to create in the internal DNS zone (never published)."
  value = var.private_dns ? [for name in local.aliases : {
    name  = name
    type  = "CNAME"
    value = aws_cloudfront_distribution.site.domain_name
  }] : []
}

output "sign_in_url" {
  description = "Where users of a private site sign in."
  value       = local.auth ? "https://${local.auth_login_host}/_sforge/auth/login" : null
}

output "auth_user_pool_id" {
  description = "Cognito user pool of a private site (sforge users)."
  value       = local.auth ? aws_cognito_user_pool.site[0].id : null
}

output "auth_key_parameter" {
  description = "SSM parameter holding the session cookie key for the sign-in Lambda (the router's copy is the KVS key auth:key)."
  value       = local.auth ? aws_ssm_parameter.auth_key[0].name : null
}
