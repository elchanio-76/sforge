# Optional custom domain: an ACM certificate in us-east-1 (required by
# CloudFront), validated through Route 53 when hosted_zone is set. Without a
# hosted zone, sforge creates the certificate first, prints the validation
# records and waits until they resolve.

resource "aws_acm_certificate" "site" {
  count                     = local.custom_domain ? 1 : 0
  provider                  = aws.us_east_1
  domain_name               = var.domain
  subject_alternative_names = var.preview_domain == null ? [] : ["*.${var.preview_domain}"]
  validation_method         = "DNS"
  tags                      = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_route53_zone" "site" {
  count        = local.custom_domain && var.hosted_zone != null ? 1 : 0
  name         = var.hosted_zone
  private_zone = false
}

locals {
  # Keyed by the configured names, so the keys are known when planning.
  certificate_names = local.custom_domain ? toset(concat(
    [var.domain],
    var.preview_domain == null ? [] : ["*.${var.preview_domain}"],
  )) : toset([])
  validation_options = local.custom_domain ? {
    for name in local.certificate_names : name => one([
      for option in aws_acm_certificate.site[0].domain_validation_options : option if option.domain_name == name
    ])
  } : {}
}

resource "aws_route53_record" "validation" {
  for_each = var.hosted_zone == null ? toset([]) : local.certificate_names

  zone_id         = data.aws_route53_zone.site[0].zone_id
  name            = local.validation_options[each.key].resource_record_name
  type            = local.validation_options[each.key].resource_record_type
  records         = [local.validation_options[each.key].resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  count                   = local.custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = var.hosted_zone == null ? null : [for record in aws_route53_record.validation : record.fqdn]

  timeouts {
    create = "2h"
  }
}

resource "aws_route53_record" "alias" {
  for_each = var.hosted_zone == null ? {} : {
    for pair in setproduct(local.aliases, ["A", "AAAA"]) : "${pair[0]} ${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  }

  zone_id = data.aws_route53_zone.site[0].zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
