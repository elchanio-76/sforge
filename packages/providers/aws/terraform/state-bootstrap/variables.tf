variable "bucket_name" {
  description = "Name of the state bucket, e.g. sforge-state-<accountId>-<region>."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key for SSE-KMS. Null uses SSE-S3."
  type        = string
  default     = null
}

variable "noncurrent_version_days" {
  description = "Days to keep previous versions of state files."
  type        = number
  default     = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
