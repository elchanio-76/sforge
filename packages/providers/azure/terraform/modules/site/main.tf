# An Azure Static Web App that sforge deploys to with the SWA deployment client.
# The app is not linked to a repository: content arrives through `sforge deploy`,
# which fetches the deployment token at run time (it is not an output and not in
# any file sforge writes).

locals {
  # Static Web App names are 2-60 characters.
  app_name = substr("${var.name}-${var.target}", 0, 60)
  tags     = merge(var.tags, { "sforge:role" = "site" })
}

resource "azurerm_resource_group" "site" {
  count = var.create_resource_group ? 1 : 0

  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

data "azurerm_resource_group" "site" {
  count = var.create_resource_group ? 0 : 1

  name = var.resource_group_name
}

resource "azurerm_static_web_app" "site" {
  name                = local.app_name
  resource_group_name = var.create_resource_group ? azurerm_resource_group.site[0].name : data.azurerm_resource_group.site[0].name
  location            = var.location

  sku_tier = var.sku
  sku_size = var.sku

  # Named preview environments (`sforge deploy --preview pr-42`).
  preview_environments_enabled = true

  tags = local.tags
}
