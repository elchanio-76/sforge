output "bucket" {
  description = "Name of the state bucket."
  value       = google_storage_bucket.state.name
}
