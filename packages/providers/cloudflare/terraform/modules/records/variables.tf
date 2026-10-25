variable "zone_id" {
  description = "Cloudflare zone that holds the records."
  type        = string
}

variable "comment" {
  description = "Note stored with each record (no effect on DNS answers)."
  type        = string
  default     = "staticforge"
}

variable "records" {
  description = "Records to create, keyed by a name known when planning (values may be unknown)."
  type = map(object({
    name  = string
    type  = string
    value = string
  }))
  default = {}

  validation {
    condition     = alltrue([for record in values(var.records) : record.type == "CNAME"])
    error_message = "Only CNAME records are supported."
  }
}
