# Plans and applies the module against a mocked Azure provider, so no
# subscription is needed. Run with `tofu test` (or `terraform test`).

mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/docs-prod"
    }
  }
  mock_data "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/shared"
    }
  }
  mock_resource "azurerm_static_web_app" {
    defaults = {
      id                = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/docs-prod/providers/Microsoft.Web/staticSites/docs-prod"
      default_host_name = "lemon-bush-0123456ab.5.azurestaticapps.net"
      api_key           = "super-secret-deployment-token"
    }
  }
}

variables {
  name                = "docs"
  target              = "prod"
  resource_group_name = "docs-prod"
  location            = "westeurope"
}

run "static_web_app_without_repository" {
  command = apply

  assert {
    condition     = azurerm_static_web_app.site.sku_tier == "Free" && azurerm_static_web_app.site.sku_size == "Free"
    error_message = "The default plan is Free."
  }

  assert {
    condition     = azurerm_static_web_app.site.preview_environments_enabled
    error_message = "Named preview environments are how PR previews work."
  }

  assert {
    condition     = azurerm_static_web_app.site.name == "docs-prod"
    error_message = "The app is named <project>-<target>."
  }

  assert {
    condition     = output.url == "https://lemon-bush-0123456ab.5.azurestaticapps.net"
    error_message = "The URL is the default *.azurestaticapps.net host."
  }
}

run "deployment_token_is_not_exported" {
  command = apply

  assert {
    # Terraform cannot enumerate outputs: add new ones to this list.
    condition = !strcontains(join(" ", [
      output.static_web_app_name,
      output.static_web_app_id,
      output.resource_group,
      output.location,
      output.sku,
      output.default_host_name,
      output.url,
    ]), "super-secret-deployment-token")
    error_message = "The deployment token must never be a module output."
  }
}

run "creates_resource_group_by_default" {
  command = apply

  assert {
    condition     = length(azurerm_resource_group.site) == 1 && length(data.azurerm_resource_group.site) == 0
    error_message = "The resource group is created unless told otherwise."
  }
}

run "uses_an_existing_resource_group" {
  command = apply

  variables {
    resource_group_name   = "shared"
    create_resource_group = false
  }

  assert {
    condition     = length(azurerm_resource_group.site) == 0 && length(data.azurerm_resource_group.site) == 1
    error_message = "An existing resource group must be read, not created."
  }
}

run "standard_plan" {
  command = apply

  variables {
    sku = "Standard"
  }

  assert {
    condition     = azurerm_static_web_app.site.sku_tier == "Standard" && azurerm_static_web_app.site.sku_size == "Standard"
    error_message = "Standard sets both tier and size."
  }
}

run "rejects_unsupported_regions" {
  command = plan

  variables {
    location = "northeurope"
  }

  expect_failures = [var.location]
}

run "long_names_are_shortened" {
  command = plan

  variables {
    name = "an-extremely-long-project-name-that-goes-on-and-on"
  }

  assert {
    condition     = length(azurerm_static_web_app.site.name) <= 60
    error_message = "Static Web App names are at most 60 characters."
  }
}
