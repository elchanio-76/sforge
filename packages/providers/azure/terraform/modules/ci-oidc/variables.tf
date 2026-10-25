variable "name" {
  description = "Project name (iac.name)."
  type        = string
}

variable "target" {
  description = "Target name, e.g. prod."
  type        = string
}

variable "subscription_id" {
  description = "Subscription of the site; part of the custom role's name, which must be unique in the tenant."
  type        = string
}

variable "repo" {
  description = "GitHub repository allowed to deploy, as owner/repo."
  type        = string
}

variable "branches" {
  description = "Branches whose workflows may deploy."
  type        = list(string)
  default     = ["main"]
}

variable "environments" {
  description = "GitHub deployment environments whose workflows may deploy."
  type        = list(string)
  default     = []
}

variable "pull_requests" {
  description = "Allow pull_request workflows to deploy previews."
  type        = bool
  default     = true
}

variable "resource_group_id" {
  description = "Resource group of the site: where the custom deploy role is defined."
  type        = string
}

variable "static_web_app_id" {
  description = "The Static Web App the identity deploys to."
  type        = string
}

variable "state_container_id" {
  description = "Resource ID of the state container."
  type        = string
}

variable "state_key" {
  description = "This target's state blob, e.g. docs/prod.tfstate."
  type        = string
}

variable "history_prefix" {
  description = "Prefix of this target's deploy history blobs, e.g. _sforge/docs/prod/."
  type        = string
}
