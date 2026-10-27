# Plans the module against a mocked Cloudflare provider, so no API token is
# needed. Run with `tofu test` (or `terraform test`).

mock_provider "cloudflare" {}

variables {
  zone_id = "023e105f4ecef8ad9ca31a8372d0c353"
  comment = "staticforge docs/staging"
  records = {
    "docs.example.com" = {
      name  = "_3f2a.docs.example.com."
      type  = "CNAME"
      value = "_9c1b.xlfgrmvvlj.acm-validations.aws."
    }
    "*.preview.example.com" = {
      name  = "*.preview.example.com"
      type  = "CNAME"
      value = "d111111abcdef8.cloudfront.net"
    }
  }
}

run "dns_only_records_without_trailing_dots" {
  command = plan

  assert {
    condition     = length(cloudflare_dns_record.this) == 2
    error_message = "One record per key."
  }
  assert {
    condition     = alltrue([for r in cloudflare_dns_record.this : r.proxied == false && r.ttl == 1])
    error_message = "Records must be DNS-only with an automatic TTL."
  }
  assert {
    condition     = cloudflare_dns_record.this["docs.example.com"].name == "_3f2a.docs.example.com"
    error_message = "Trailing dots are removed from names."
  }
  assert {
    condition     = cloudflare_dns_record.this["docs.example.com"].content == "_9c1b.xlfgrmvvlj.acm-validations.aws"
    error_message = "Trailing dots are removed from targets."
  }
  assert {
    condition     = cloudflare_dns_record.this["*.preview.example.com"].comment == "staticforge docs/staging"
    error_message = "Records carry the comment."
  }
}

run "fqdns_output" {
  assert {
    condition     = toset(output.fqdns) == toset(["_3f2a.docs.example.com", "*.preview.example.com"])
    error_message = "fqdns lists the record names."
  }
}

run "quoted_txt_records" {
  command = plan

  variables {
    records = {
      "docs.example.com" = { name = "_dnsauth.docs.example.com", type = "TXT", value = "abc123" }
    }
  }

  assert {
    condition     = cloudflare_dns_record.this["docs.example.com"].content == "\"abc123\""
    error_message = "TXT content is quoted."
  }
}

run "only_cname_and_txt_records" {
  command = plan

  variables {
    records = {
      "docs.example.com" = { name = "docs.example.com", type = "A", value = "192.0.2.1" }
    }
  }

  expect_failures = [var.records]
}
