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
  mock_resource "azurerm_static_web_app_custom_domain" {
    defaults = {
      validation_token = "tok3n"
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
      output.resource_group_id,
      jsonencode(output.dns_records),
      jsonencode(output.dns_routing_records),
      jsonencode(output.validation_records),
      jsonencode(output.dns_validation_records),
      jsonencode(output.dns_private_records),
      jsonencode(output.sign_in_url),
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

run "custom_domain_after_its_cname" {
  command = apply

  variables {
    domain    = "azure.docs.example.com"
    dns_ready = { "azure.docs.example.com" = "023e105f4ecef8ad9ca31a8372d0c353" }
  }

  assert {
    condition     = azurerm_static_web_app_custom_domain.site[0].domain_name == "azure.docs.example.com" && azurerm_static_web_app_custom_domain.site[0].validation_type == "cname-delegation"
    error_message = "The domain is validated through its CNAME to the app."
  }

  assert {
    condition     = terraform_data.dns_ready[0].output["azure.docs.example.com"] == "023e105f4ecef8ad9ca31a8372d0c353"
    error_message = "The custom domain waits for the records of the DNS module."
  }

  assert {
    condition = output.dns_routing_records == {
      "azure.docs.example.com" = { name = "azure.docs.example.com", type = "CNAME", value = "lemon-bush-0123456ab.5.azurestaticapps.net" }
    }
    error_message = "The CNAME points the domain at the app's default host."
  }

  assert {
    condition     = output.url == "https://azure.docs.example.com"
    error_message = "The URL uses the custom domain."
  }
}

run "no_custom_domain_by_default" {
  command = apply

  assert {
    condition     = length(azurerm_static_web_app_custom_domain.site) == 0 && length(output.dns_records) == 0 && length(output.dns_routing_records) == 0
    error_message = "Without a domain there is nothing to validate or point."
  }

  assert {
    condition     = length(output.validation_records) == 0 && length(output.dns_validation_records) == 0 && length(output.dns_private_records) == 0 && output.sign_in_url == null
    error_message = "Public sites without private DNS have no TXT validation or sign-in."
  }
}


run "private_domain_validated_by_txt" {
  command = apply

  variables {
    domain        = "intra.docs.example.com"
    private_dns   = true
    auth_provider = "aad"
  }

  assert {
    condition     = azurerm_static_web_app_custom_domain.site[0].validation_type == "dns-txt-token"
    error_message = "A private domain is validated with a TXT token."
  }

  assert {
    condition     = jsonencode(output.validation_records) == jsonencode([{ name = "_dnsauth.intra.docs.example.com", type = "TXT", value = "tok3n" }])
    error_message = "The TXT record is listed for the public zone."
  }

  assert {
    condition     = output.dns_validation_records["intra.docs.example.com"].value == "tok3n"
    error_message = "A DNS module can create the TXT record."
  }

  assert {
    condition     = length(output.dns_records) == 0 && length(output.dns_routing_records) == 0
    error_message = "The CNAME is not published."
  }

  assert {
    condition     = jsonencode(output.dns_private_records) == jsonencode([{ name = "intra.docs.example.com", type = "CNAME", value = "lemon-bush-0123456ab.5.azurestaticapps.net" }])
    error_message = "The CNAME is listed for the internal DNS."
  }

  assert {
    condition     = output.sign_in_url == "https://intra.docs.example.com/.auth/login/aad"
    error_message = "Users sign in with the first provider on the domain."
  }
}
