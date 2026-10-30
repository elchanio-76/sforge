variable "project" {
  description = "Google Cloud project that holds the bucket."
  type        = string
}

variable "bucket" {
  description = "Name of the state bucket."
  type        = string
}

variable "location" {
  description = "Bucket location, e.g. EU or europe-north1."
  type        = string
  default     = "EU"
}
