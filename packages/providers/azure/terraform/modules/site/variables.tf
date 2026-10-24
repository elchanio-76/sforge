variable "name" {
  description = "Project name (iac.name), used in resource names and tags."
  type        = string
}

variable "target" {
  description = "Target name, e.g. prod."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group of the site."
  type        = string
}

variable "create_resource_group" {
  description = "Create the resource group (and delete it with the site). False uses an existing one."
  type        = bool
  default     = true
}

variable "location" {
  description = "Azure region. Static Web Apps are only available in a few (westus2, centralus, eastus2, westeurope, eastasia)."
  type        = string
  validation {
    condition     = contains(["westus2", "centralus", "eastus2", "westeurope", "eastasia"], var.location)
    error_message = "Static Web Apps are available in westus2, centralus, eastus2, westeurope and eastasia."
  }
}

variable "sku" {
  description = "Free or Standard."
  type        = string
  default     = "Free"
  validation {
    condition     = contains(["Free", "Standard"], var.sku)
    error_message = "sku must be \"Free\" or \"Standard\"."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
