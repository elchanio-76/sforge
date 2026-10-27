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

# Optional custom domain. cname-delegation validation needs the CNAME to the
# app's default host to exist first; the provider then polls until Azure has
# validated it and issued the free managed certificate. With private_dns the
# CNAME exists only in an internal zone Azure cannot see, so the domain is
# validated with a TXT token (_dnsauth.<domain>) in the public zone instead.

resource "terraform_data" "dns_ready" {
  count = var.domain == null ? 0 : 1
  input = var.dns_ready
}

resource "azurerm_static_web_app_custom_domain" "site" {
  count = var.domain == null ? 0 : 1

  static_web_app_id = azurerm_static_web_app.site.id
  domain_name       = var.domain
  validation_type   = var.private_dns ? "dns-txt-token" : "cname-delegation"

  timeouts {
    create = "1h"
  }

  depends_on = [terraform_data.dns_ready]
}
