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

variable "validation_record_fqdns" {
  description = "Validation records created outside this module (e.g. in Cloudflare): the certificate validation waits for them. Ignored with hosted_zone; null without it means the user creates the printed records."
  type        = list(string)
  default     = null
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
    subject_prefix       = string # repo:owner/repo, or repo:owner@<id>/repo@<id> (immutable subjects)
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

variable "site_title" {
  description = "site.title, used in the invitations of private sites."
  type        = string
  default     = null
}

variable "auth" {
  description = "Require signing in on every URL (users in a Cognito user pool). Null serves a public site."
  type = object({
    session_hours         = optional(number, 8)
    mfa                   = optional(string, "optional")
    allow_cloudfront_host = optional(bool, false)
  })
  default = null
  validation {
    condition     = var.auth == null || contains(["off", "optional", "required"], try(var.auth.mfa, ""))
    error_message = "auth.mfa must be \"off\", \"optional\" or \"required\"."
  }
  validation {
    condition     = var.auth == null || (try(var.auth.session_hours, 0) >= 1 && try(var.auth.session_hours, 0) <= 24)
    error_message = "auth.session_hours must be between 1 and 24."
  }
}

variable "private_dns" {
  description = "The domain resolves only in a private zone: no routing records are created (dns_private_records lists them), only certificate validation."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
