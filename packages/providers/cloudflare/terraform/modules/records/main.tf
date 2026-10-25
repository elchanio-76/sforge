# DNS records for a custom domain: certificate validation and routing. They are
# DNS-only, never proxied: CloudFront and Static Web Apps terminate TLS with
# their own certificates, and validation needs the real CNAME targets.

resource "cloudflare_dns_record" "this" {
  for_each = var.records

  zone_id = var.zone_id
  # ACM returns names and targets with a trailing dot; Cloudflare stores them without.
  name    = trimsuffix(each.value.name, ".")
  type    = each.value.type
  content = trimsuffix(each.value.value, ".")
  ttl     = 1 # automatic
  proxied = false
  comment = var.comment
}
