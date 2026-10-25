output "client_id" {
  description = "AZURE_CLIENT_ID for azure/login."
  value       = azuread_application.ci.client_id
}

output "tenant_id" {
  description = "AZURE_TENANT_ID for azure/login."
  value       = data.azuread_client_config.current.tenant_id
}

output "subscription_id" {
  description = "AZURE_SUBSCRIPTION_ID for azure/login."
  value       = var.subscription_id
}

output "principal_id" {
  value = azuread_service_principal.ci.object_id
}
