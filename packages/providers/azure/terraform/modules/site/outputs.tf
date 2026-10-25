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
  description = "The CNAME pointing the custom domain at the app (create it when sforge does not manage DNS)."
  value = var.domain == null ? [] : [{
    name  = var.domain
    type  = "CNAME"
    value = azurerm_static_web_app.site.default_host_name
  }]
}

output "dns_routing_records" {
  description = "dns_records keyed by name, for a DNS module to create."
  value = {
    for name in compact([var.domain]) : name => {
      name  = name
      type  = "CNAME"
      value = azurerm_static_web_app.site.default_host_name
    }
  }
}
