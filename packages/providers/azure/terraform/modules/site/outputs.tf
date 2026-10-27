output "static_web_app_name" {
  value = azurerm_static_web_app.site.name
}

output "static_web_app_id" {
  value = azurerm_static_web_app.site.id
}

output "resource_group" {
  value = var.resource_group_name
}

output "resource_group_id" {
  value = var.create_resource_group ? azurerm_resource_group.site[0].id : data.azurerm_resource_group.site[0].id
}

output "location" {
  value = var.location
}

output "sku" {
  value = var.sku
}

output "default_host_name" {
  value = azurerm_static_web_app.site.default_host_name
}

output "url" {
  value = "https://${var.domain == null ? azurerm_static_web_app.site.default_host_name : var.domain}"
}

output "domain" {
  value = var.domain
}

output "dns_records" {
  description = "The CNAME pointing the custom domain at the app (create it when sforge does not manage DNS). Empty with private_dns."
  value = var.domain == null || var.private_dns ? [] : [{
    name  = var.domain
    type  = "CNAME"
    value = azurerm_static_web_app.site.default_host_name
  }]
}

output "dns_routing_records" {
  description = "dns_records keyed by name, for a DNS module to create."
  value = {
    for name in(var.private_dns ? [] : compact([var.domain])) : name => {
      name  = name
      type  = "CNAME"
      value = azurerm_static_web_app.site.default_host_name
    }
  }
}

locals {
  # The token is not secret: it is published in DNS.
  validation_token = var.domain != null && var.private_dns ? nonsensitive(azurerm_static_web_app_custom_domain.site[0].validation_token) : null
}

output "validation_records" {
  description = "With private_dns: the TXT record that validates the domain, in the public zone."
  value = local.validation_token == null ? [] : [{
    name  = "_dnsauth.${var.domain}"
    type  = "TXT"
    value = local.validation_token
  }]
}

output "dns_validation_records" {
  description = "validation_records keyed by domain, for a DNS module to create."
  value = {
    for name in(var.private_dns ? compact([var.domain]) : []) : name => {
      name  = "_dnsauth.${name}"
      type  = "TXT"
      value = local.validation_token
    }
  }
}

output "dns_private_records" {
  description = "With private_dns: the CNAME to create in the internal DNS zone (never published)."
  value = var.domain == null || !var.private_dns ? [] : [{
    name  = var.domain
    type  = "CNAME"
    value = azurerm_static_web_app.site.default_host_name
  }]
}

output "sign_in_url" {
  description = "Where users of a private site sign in (null when public)."
  value       = var.auth_provider == null ? null : "https://${var.domain == null ? azurerm_static_web_app.site.default_host_name : var.domain}/.auth/login/${var.auth_provider}"
}
