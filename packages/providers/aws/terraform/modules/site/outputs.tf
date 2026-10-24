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
  description = "Records pointing the custom domain at CloudFront (created when hosted_zone is set)."
  value = [for name in local.aliases : {
    name  = name
    type  = "CNAME"
    value = aws_cloudfront_distribution.site.domain_name
  }]
}

output "ci_role_arn" {
  value = local.ci == null ? null : aws_iam_role.ci[0].arn
}

output "oidc_provider_arn" {
  value = local.oidc_provider_arn
}
