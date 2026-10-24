variable "name" {
  description = "Project name (iac.name), used in resource names and tags."
  type        = string
}

variable "target" {
  description = "Target name, e.g. staging."
  type        = string
}

variable "trailing_slash" {
  description = "build.trailingSlash: how the router maps extensionless URLs."
  type        = string
  default     = "always"
  validation {
    condition     = contains(["always", "never"], var.trailing_slash)
    error_message = "trailing_slash must be \"always\" or \"never\"."
  }
}

variable "domain" {
  description = "Custom domain. Null serves the site from the *.cloudfront.net domain."
  type        = string
  default     = null
}

variable "hosted_zone" {
  description = "Route 53 hosted zone for DNS validation and alias records. Null prints the records instead."
  type        = string
  default     = null
}

variable "preview_domain" {
  description = "Parent domain of PR previews (pr-<n>.<preview_domain>). Needs domain."
  type        = string
  default     = null
}

variable "wait_for_validation" {
  description = "Wait for the ACM certificate to be validated (false only creates the certificate)."
  type        = bool
  default     = true
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "logging" {
  description = "Write CloudFront standard access logs to a separate bucket."
  type        = bool
  default     = false
}

variable "waf_web_acl_arn" {
  type    = string
  default = null
}

variable "force_destroy" {
  description = "Allow the content bucket to be deleted while it holds objects (set by sforge destroy)."
  type        = bool
  default     = false
}

variable "security_headers" {
  description = "Security headers sent with every response."
  type = object({
    content_security_policy        = optional(string)
    search_content_security_policy = optional(string)
    hsts_max_age                   = optional(number)
    hsts_include_subdomains        = optional(bool, false)
    hsts_preload                   = optional(bool, false)
    referrer_policy                = optional(string, "strict-origin-when-cross-origin")
    frame_options                  = optional(string, "SAMEORIGIN")
    permissions_policy             = optional(string)
  })
  default = {}
}

variable "search_paths" {
  description = "Path patterns of the search page, which gets search_content_security_policy (Pagefind needs WebAssembly)."
  type        = list(string)
  default     = []
}

variable "ci" {
  description = "GitHub Actions OIDC deploy role. Null creates none."
  type = object({
    repo                 = string
    branches             = list(string)
    environments         = list(string)
    pull_requests        = bool
    create_oidc_provider = bool
    oidc_provider_arn    = optional(string)
    state_bucket         = optional(string)
    state_key            = optional(string)
  })
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
