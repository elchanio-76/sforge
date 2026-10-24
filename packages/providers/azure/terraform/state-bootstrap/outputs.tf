# Both depend on the role propagation, so the migration into the backend starts after it.

output "resource_group" {
  value      = azurerm_resource_group.state.name
  depends_on = [time_sleep.role_propagation]
}

output "storage_account" {
  value      = azurerm_storage_account.state.name
  depends_on = [time_sleep.role_propagation]
}

output "storage_account_id" {
  value      = azurerm_storage_account.state.id
  depends_on = [time_sleep.role_propagation]
}

output "container" {
  value      = azurerm_storage_container.state.name
  depends_on = [time_sleep.role_propagation]
}
