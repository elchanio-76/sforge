# Plans and applies the module against mocked providers, so no Azure
# subscription is needed. Run with `tofu test` (or `terraform test`).

mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/sforge-state"
    }
  }
  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/sforge-state/providers/Microsoft.Storage/storageAccounts/sfstate0123456789ab"
    }
  }
  mock_data "azurerm_client_config" {
    defaults = {
      object_id       = "11111111-1111-1111-1111-111111111111"
      tenant_id       = "22222222-2222-2222-2222-222222222222"
      subscription_id = "33333333-3333-3333-3333-333333333333"
    }
  }
}

mock_provider "time" {}

variables {
  resource_group_name    = "sforge-state"
  location               = "westeurope"
  storage_account_name   = "sfstate0123456789ab"
  role_propagation_delay = "0s"
}

run "private_storage_without_access_keys" {
  command = apply

  assert {
    condition     = azurerm_storage_account.state.shared_access_key_enabled == false
    error_message = "State must be authenticated with Entra ID, not account keys."
  }

  assert {
    condition     = azurerm_storage_account.state.allow_nested_items_to_be_public == false
    error_message = "Blobs must never be publicly readable."
  }

  assert {
    condition     = azurerm_storage_account.state.min_tls_version == "TLS1_2" && azurerm_storage_account.state.https_traffic_only_enabled
    error_message = "Only TLS 1.2 or later over HTTPS is allowed."
  }

  assert {
    condition     = azurerm_storage_container.state.container_access_type == "private"
    error_message = "The state container must be private."
  }
}

run "state_can_be_recovered" {
  command = apply

  assert {
    condition     = azurerm_storage_account.state.blob_properties[0].versioning_enabled
    error_message = "Blob versioning keeps previous state files."
  }

  assert {
    condition     = azurerm_storage_account.state.blob_properties[0].delete_retention_policy[0].days >= 7
    error_message = "Deleted state must stay recoverable."
  }
}

run "caller_gets_data_access" {
  command = apply

  assert {
    condition     = azurerm_role_assignment.caller.role_definition_name == "Storage Blob Data Contributor"
    error_message = "Owner cannot read blobs: the caller needs the data role."
  }

  assert {
    condition     = azurerm_role_assignment.caller.principal_id == "11111111-1111-1111-1111-111111111111"
    error_message = "The role goes to the identity that runs the bootstrap."
  }
}

run "extra_principals" {
  command = apply

  variables {
    data_contributors = ["44444444-4444-4444-4444-444444444444"]
  }

  assert {
    condition     = length(azurerm_role_assignment.extra) == 1
    error_message = "Additional principals should each get the data role."
  }
}

run "rejects_bad_account_names" {
  command = plan

  variables {
    storage_account_name = "Not_Valid"
  }

  expect_failures = [var.storage_account_name]
}
