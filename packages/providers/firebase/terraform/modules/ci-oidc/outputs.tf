output "workload_identity_provider" {
  description = "Full name of the provider, for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "service_account" {
  description = "Email of the service account CI acts as."
  value       = google_service_account.ci.email
}
