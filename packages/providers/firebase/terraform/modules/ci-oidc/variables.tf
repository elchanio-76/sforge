variable "name" {
  description = "Project name, for naming."
  type        = string
}

variable "target" {
  description = "Target name, for naming."
  type        = string
}

variable "project" {
  description = "Google Cloud project of the site."
  type        = string
}

variable "repo" {
  description = "GitHub repository, as owner/repo."
  type        = string
}

variable "subject_prefix" {
  description = "Start of the repository's OIDC subjects, e.g. repo:owner@1/repo@2."
  type        = string
}

variable "branches" {
  description = "Branches whose workflows may deploy."
  type        = list(string)
  default     = ["main"]
}

variable "environments" {
  description = "GitHub environments whose workflows may deploy."
  type        = list(string)
  default     = []
}

variable "pull_requests" {
  description = "Allow pull_request workflows to deploy previews."
  type        = bool
  default     = true
}

variable "state_bucket" {
  description = "Bucket that holds the target's state."
  type        = string
}

variable "state_prefix" {
  description = "Prefix of the target's state in the bucket."
  type        = string
}
