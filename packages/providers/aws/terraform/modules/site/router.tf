# Routing at the edge: a viewer-request function maps clean URLs to objects and
# prefixes them with the active version, which lives in a KeyValueStore. A
# deploy or rollback is one KVS key update: no distribution change, and since
# the rewritten URI is the cache key, no invalidation either.

resource "aws_cloudfront_key_value_store" "site" {
  name    = substr("sforge-${local.id}", 0, 64)
  comment = "staticforge ${local.id}: active version, previews and routes"
}

# Seeded once; deploys and rollbacks change the value with the SDK, so the
# value is ignored here and never shows up as drift.
resource "aws_cloudfrontkeyvaluestore_key" "active" {
  key_value_store_arn = aws_cloudfront_key_value_store.site.arn
  key                 = "active"
  value               = "none"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_cloudfront_function" "router" {
  name    = substr("sforge-${local.id}-router", 0, 64)
  comment = "staticforge URL routing and versions"
  runtime = "cloudfront-js-2.0"
  publish = true
  code = replace(file("${path.module}/router.js"), "__SFORGE_CONFIG__", jsonencode({
    trailingSlash = var.trailing_slash
    previewSuffix = var.preview_domain == null ? "" : ".${var.preview_domain}"
  }))
  key_value_store_associations = [aws_cloudfront_key_value_store.site.arn]
}
