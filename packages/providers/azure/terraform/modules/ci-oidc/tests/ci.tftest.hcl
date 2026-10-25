# Plans and applies the module against mocked Azure providers, so no tenant or
# subscription is needed. Run with `tofu test` (or `terraform test`).

mock_provider "azurerm" {
  mock_resource "azurerm_role_definition" {
    defaults = {
      role_definition_resource_id = "/subscriptions/33333333-3333-3333-3333-333333333333/providers/Microsoft.Authorization/roleDefinitions/44444444-4444-4444-4444-444444444444"
    }
  }
}

mock_provider "azuread" {
  mock_data "azuread_client_config" {
    defaults = {
      object_id = "55555555-5555-5555-5555-555555555555"
      tenant_id = "66666666-6666-6666-6666-666666666666"
    }
  }
  mock_resource "azuread_application" {
    defaults = {
      id        = "/applications/77777777-7777-7777-7777-777777777777"
      client_id = "88888888-8888-8888-8888-888888888888"
    }
  }
  mock_resource "azuread_service_principal" {
    defaults = {
      object_id = "99999999-9999-9999-9999-999999999999"
    }
  }
}

variables {
  name               = "docs"
  target             = "prod"
  subscription_id    = "33333333-3333-3333-3333-333333333333"
  repo               = "acme/docs"
  subject_prefix     = "repo:acme@1001/docs@2002"
  branches           = ["main", "release/1.x"]
  environments       = ["production"]
  resource_group_id  = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/docs-prod"
  static_web_app_id  = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/docs-prod/providers/Microsoft.Web/staticSites/docs-prod"
  state_container_id = "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/sforge-state/providers/Microsoft.Storage/storageAccounts/sfstate123/blobServices/default/containers/tfstate"
  state_key          = "docs/prod.tfstate"
  history_prefix     = "_sforge/docs/prod/"
}

run "one_federated_login_per_subject" {
  command = apply

  assert {
    condition = { for k, c in azuread_application_federated_identity_credential.github : k => c.subject } == {
      "branch-main"            = "repo:acme@1001/docs@2002:ref:refs/heads/main"
      "branch-release-1-x"     = "repo:acme@1001/docs@2002:ref:refs/heads/release/1.x"
      "environment-production" = "repo:acme@1001/docs@2002:environment:production"
      "pull-request"           = "repo:acme@1001/docs@2002:pull_request"
    }
    error_message = "One federated login per branch, environment and pull requests, with names Entra accepts."
  }

  assert {
    condition = alltrue([for c in azuread_application_federated_identity_credential.github :
      c.issuer == "https://token.actions.githubusercontent.com" && toset(c.audiences) == toset(["api://AzureADTokenExchange"])
    ])
    error_message = "Logins trust GitHub's OIDC issuer with the Entra token-exchange audience."
  }

  assert {
    condition     = output.client_id == "88888888-8888-8888-8888-888888888888" && output.tenant_id == "66666666-6666-6666-6666-666666666666"
    error_message = "The client and tenant IDs are what azure/login needs."
  }
}

run "least_privilege_roles" {
  command = apply

  assert {
    condition     = toset(one(azurerm_role_definition.deploy.permissions).actions) == toset(["Microsoft.Web/staticSites/read", "Microsoft.Web/staticSites/builds/read", "Microsoft.Web/staticSites/builds/delete", "Microsoft.Web/staticSites/listSecrets/action"])
    error_message = "The deploy role may only read the app, list and delete environments, and read the deployment token."
  }

  assert {
    condition     = azurerm_role_assignment.deploy.scope == var.static_web_app_id
    error_message = "The deploy role is assigned on the app only."
  }

  assert {
    condition     = azurerm_role_definition.deploy.name == "staticforge deploy docs/prod (33333333)"
    error_message = "Role names are unique per tenant: they include the subscription."
  }

  assert {
    condition = (
      azurerm_role_assignment.state.scope == var.state_container_id &&
      strcontains(azurerm_role_assignment.state.condition, "StringEquals 'docs/prod.tfstate'") &&
      strcontains(azurerm_role_assignment.state.condition, "StringStartsWith '_sforge/docs/prod/'")
    )
    error_message = "State access is limited to the target's state blob and history."
  }
}

run "no_pull_requests" {
  command = plan

  variables {
    branches      = ["main"]
    environments  = []
    pull_requests = false
  }

  assert {
    condition     = keys(azuread_application_federated_identity_credential.github) == ["branch-main"]
    error_message = "Without pull requests, only the branch may deploy."
  }
}
