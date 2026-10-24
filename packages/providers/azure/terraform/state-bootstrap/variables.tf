variable "resource_group_name" {
  description = "Resource group of the state storage account, e.g. sforge-state."
  type        = string
}

variable "location" {
  description = "Azure region of the state storage account."
  type        = string
}

variable "storage_account_name" {
  description = "Globally unique name (3-24 lowercase letters and digits), e.g. sfstate0123456789ab."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "storage_account_name must be 3-24 lowercase letters and digits."
  }
}

variable "container_name" {
  description = "Blob container that holds the state files."
  type        = string
  default     = "tfstate"
}

variable "replication_type" {
  description = "Storage replication (LRS, ZRS, GRS, ...)."
  type        = string
  default     = "LRS"
}

variable "retention_days" {
  description = "Days that deleted blobs and containers (and so state files) stay recoverable."
  type        = number
  default     = 30
}

variable "data_contributors" {
  description = "Object IDs of further principals that may read and write state. The caller always can."
  type        = list(string)
  default     = []
}

variable "role_propagation_delay" {
  description = "Wait after granting data access: Azure RBAC takes minutes to take effect, and the state is migrated right after."
  type        = string
  default     = "120s"
}

variable "tags" {
  type    = map(string)
  default = {}
}
