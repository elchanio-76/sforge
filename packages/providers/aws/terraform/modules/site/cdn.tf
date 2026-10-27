locals {
  custom_domain = var.domain != null
  aliases = local.custom_domain ? concat(
    [var.domain],
    var.preview_domain == null ? [] : ["*.${var.preview_domain}"],
  ) : []
  # Served by CloudFront's error responses; sforge copies the active version's
  # 404.html here on every deploy and rollback.
  error_page = "/_sforge/errors/404.html"
  headers    = var.security_headers
  header_policies = merge(
    { default = local.headers.content_security_policy },
    length(var.search_paths) > 0 ? { search = local.headers.search_content_security_policy } : {},
  )
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = substr("sforge-${local.id}", 0, 64)
  description                       = "staticforge ${local.id}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Honors the Cache-Control set on each object: immutable for fingerprinted
# assets, max-age=0 + must-revalidate (ETag revalidation) for everything else.
resource "aws_cloudfront_cache_policy" "site" {
  name        = "sforge-${local.id}"
  comment     = "staticforge: origin Cache-Control, no cookies or query strings"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "site" {
  for_each = local.header_policies
  name     = "sforge-${local.id}-${each.key}"
  comment  = "staticforge security headers (${each.key})"

  security_headers_config {
    content_type_options {
      override = true
    }

    dynamic "frame_options" {
      for_each = local.headers.frame_options == null ? [] : [local.headers.frame_options]
      content {
        frame_option = frame_options.value
        override     = true
      }
    }

    dynamic "referrer_policy" {
      for_each = local.headers.referrer_policy == null ? [] : [local.headers.referrer_policy]
      content {
        referrer_policy = referrer_policy.value
        override        = true
      }
    }

    dynamic "strict_transport_security" {
      for_each = local.headers.hsts_max_age == null ? [] : [local.headers.hsts_max_age]
      content {
        access_control_max_age_sec = strict_transport_security.value
        include_subdomains         = local.headers.hsts_include_subdomains
        preload                    = local.headers.hsts_preload
        override                   = true
      }
    }

    dynamic "content_security_policy" {
      for_each = each.value == null ? [] : [each.value]
      content {
        content_security_policy = content_security_policy.value
        override                = true
      }
    }
  }

  dynamic "custom_headers_config" {
    for_each = local.headers.permissions_policy == null ? [] : [local.headers.permissions_policy]
    content {
      items {
        header   = "Permissions-Policy"
        value    = custom_headers_config.value
        override = true
      }
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled         = true
  comment         = "staticforge ${local.id}"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.price_class
  aliases         = local.aliases
  web_acl_id      = var.waf_web_acl_arn
  tags            = local.tags

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # The sign-in Lambda of private sites (auth.tf).
  dynamic "origin" {
    for_each = local.auth ? [aws_lambda_function_url.auth[0].function_url] : []
    content {
      origin_id                = "auth"
      domain_name              = trimsuffix(trimprefix(origin.value, "https://"), "/")
      origin_access_control_id = aws_cloudfront_origin_access_control.auth[0].id
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.site.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site["default"].id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.router.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.auth ? ["/_sforge/auth/*"] : []
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "auth"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = data.aws_cloudfront_cache_policy.disabled[0].id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host[0].id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.site["default"].id

      # Passes the viewer's host on to the Lambda.
      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.router.arn
      }
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.search_paths
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "site"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = aws_cloudfront_cache_policy.site.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.site["search"].id

      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.router.arn
      }
    }
  }

  # S3 answers 404 for missing objects (403 if listing were not allowed).
  dynamic "custom_error_response" {
    for_each = [403, 404]
    content {
      error_code            = custom_error_response.value
      response_code         = 404
      response_page_path    = local.error_page
      error_caching_min_ttl = 10
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    # The default *.cloudfront.net certificate does not allow choosing the policy.
    minimum_protocol_version = local.custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  dynamic "logging_config" {
    for_each = var.logging ? [1] : []
    content {
      bucket          = aws_s3_bucket.logs[0].bucket_domain_name
      include_cookies = false
      prefix          = "cloudfront/"
    }
  }

  depends_on = [aws_s3_bucket_acl.logs]
}
