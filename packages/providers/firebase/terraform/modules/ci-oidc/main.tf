# The identity GitHub Actions deploys with: a service account that a Workload
# Identity pool lets the repository's workflows act as. Nothing is stored in
# GitHub: each job signs in with its own short-lived OIDC token.

data "google_project" "this" {
  project_id = var.project
}

locals {
  id = substr(sha256("${var.name}/${var.target}"), 0, 8)
  subjects = concat(
    [for branch in var.branches : "${var.subject_prefix}:ref:refs/heads/${branch}"],
    [for environment in var.environments : "${var.subject_prefix}:environment:${environment}"],
    var.pull_requests ? ["${var.subject_prefix}:pull_request"] : [],
  )
}

# A deleted pool blocks its ID for 30 days, so a new one must not reuse it.
resource "random_id" "pool" {
  byte_length = 2
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project
  workload_identity_pool_id = "sforge-${local.id}-${random_id.pool.hex}"
  display_name              = "sforge CI ${substr(var.target, 0, 20)}"
  description               = "GitHub Actions of ${var.repo}"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"

  # The subject prefix holds the repository's immutable IDs where GitHub uses
  # them, so a renamed or recreated repository does not inherit access.
  attribute_condition = "assertion.sub.startsWith('${var.subject_prefix}:')"
  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "ci" {
  project      = var.project
  account_id   = "sforge-ci-${local.id}"
  display_name = "sforge CI ${substr(var.target, 0, 40)}"
  description  = "Deploys ${var.name}/${var.target} from GitHub Actions of ${var.repo}"
}

resource "google_service_account_iam_member" "subject" {
  for_each = toset(local.subjects)

  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/${each.value}"
}

# Firebase Hosting has no role for a single site: this covers every site in the
# project, which is why the docs suggest one project per site that needs isolating.
resource "google_project_iam_member" "hosting" {
  project = var.project
  role    = "roles/firebasehosting.admin"
  member  = google_service_account.ci.member
}

# CI only reads the outputs of its own target from state. `init` lists the bucket,
# and listing is checked against the bucket rather than an object.
resource "google_storage_bucket_iam_member" "state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectViewer"
  member = google_service_account.ci.member

  condition {
    title      = "state-${local.id}"
    expression = "resource.type == 'storage.googleapis.com/Bucket' || resource.name.startsWith('projects/_/buckets/${var.state_bucket}/objects/${var.state_prefix}/')"
  }
}
