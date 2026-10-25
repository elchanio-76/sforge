# GitHub Actions deploy identity for a Static Web App: an Entra application
# that GitHub's OIDC tokens can sign in as (no secrets), allowed only for the
# configured branches, environments and pull requests of one repository.

data "azuread_client_config" "current" {}

locals {
  label = "${var.name}/${var.target}"
  # Federated credential names allow letters, digits, "-" and "_".
  subjects = merge(
    { for branch in var.branches : substr("branch-${replace(branch, "/[^A-Za-z0-9_-]/", "-")}", 0, 120) => "repo:${var.repo}:ref:refs/heads/${branch}" },
    { for environment in var.environments : substr("environment-${replace(environment, "/[^A-Za-z0-9_-]/", "-")}", 0, 120) => "repo:${var.repo}:environment:${environment}" },
    var.pull_requests ? { "pull-request" = "repo:${var.repo}:pull_request" } : {},
  )
  blobs = "Microsoft.Storage/storageAccounts/blobServices/containers/blobs"
}

resource "azuread_application" "ci" {
  display_name = "staticforge ${local.label} deploy"
  owners       = [data.azuread_client_config.current.object_id]
  notes        = "GitHub Actions deploys of ${local.label} from ${var.repo}, managed by staticforge."
}

resource "azuread_service_principal" "ci" {
  client_id = azuread_application.ci.client_id
  owners    = [data.azuread_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "github" {
  for_each = local.subjects

  application_id = azuread_application.ci.id
  display_name   = each.key
  description    = "GitHub Actions: ${each.value}"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = each.value
}

# What `sforge deploy`, `rollback` and `preview-destroy` call: list environments,
# read the deployment token, delete preview environments. Custom roles are defined
# on a resource group (they cannot be assignable to a single resource) and this
# one is assigned on the app only.
resource "azurerm_role_definition" "deploy" {
  name        = "staticforge deploy ${local.label} (${substr(var.subscription_id, 0, 8)})"
  scope       = var.resource_group_id
  description = "GitHub Actions deploys of ${local.label} to its Static Web App, managed by staticforge."

  permissions {
    actions = [
      "Microsoft.Web/staticSites/read",
      "Microsoft.Web/staticSites/builds/read",
      "Microsoft.Web/staticSites/builds/delete",
      "Microsoft.Web/staticSites/listSecrets/action",
    ]
  }

  assignable_scopes = [var.resource_group_id]
}

resource "azurerm_role_assignment" "deploy" {
  scope              = var.static_web_app_id
  role_definition_id = azurerm_role_definition.deploy.role_definition_resource_id
  principal_id       = azuread_service_principal.ci.object_id
  # Skips the directory lookup that fails while a new principal replicates.
  principal_type = "ServicePrincipal"
}

# Reading this target's state (outputs in CI) and writing its deploy history.
# Other blobs can be listed (the backend lists the container) but not read,
# written or deleted.
resource "azurerm_role_assignment" "state" {
  scope                = var.state_container_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azuread_service_principal.ci.object_id
  principal_type       = "ServicePrincipal"
  condition_version    = "2.0"
  condition            = <<-EOT
    (
     (
      !(ActionMatches{'${local.blobs}/read'} AND NOT SubOperationMatches{'Blob.List'})
      AND !(ActionMatches{'${local.blobs}/write'})
      AND !(ActionMatches{'${local.blobs}/add/action'})
      AND !(ActionMatches{'${local.blobs}/delete'})
     )
     OR
     (
      @Resource[${local.blobs}:path] StringEquals '${var.state_key}'
      OR @Resource[${local.blobs}:path] StringStartsWith '${var.history_prefix}'
     )
    )
  EOT
}
