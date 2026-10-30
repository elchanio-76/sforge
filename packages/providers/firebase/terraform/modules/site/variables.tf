variable "project" {
  description = "Existing Google Cloud project, with billing linked."
  type        = string
}

variable "site_id" {
  description = "Firebase Hosting site ID, unique across all of Firebase."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$", var.site_id))
    error_message = "A site ID is 4-30 lowercase letters, digits or hyphens."
  }
}

variable "domain" {
  description = "Custom domain, or null for the *.web.app URL only."
  type        = string
  default     = null
}
