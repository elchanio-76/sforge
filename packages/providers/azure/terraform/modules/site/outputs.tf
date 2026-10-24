output "static_web_app_name" {
  value = azurerm_static_web_app.site.name
}

output "static_web_app_id" {
  value = azurerm_static_web_app.site.id
}

output "resource_group" {
  value = var.resource_group_name
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
  value = "https://${azurerm_static_web_app.site.default_host_name}"
}
