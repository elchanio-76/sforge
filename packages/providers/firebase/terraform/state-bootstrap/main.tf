# The Cloud Storage bucket that holds the state of a project's targets. Created
# once per Google Cloud project by `sforge provision --bootstrap-state`, then
# kept: it outlives every target, and destroying it would orphan their state.
#
# Access needs no binding here: a new bucket gives the project's owners and
# editors its objects through the default legacy roles. (Binding the caller
# explicitly does not work anyway: google_client_openid_userinfo returns a null
# email with user_project_override, because Google's OpenID endpoint refuses the
# quota project header and the provider hides the error.)

resource "google_project_service" "storage" {
  project            = var.project
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_storage_bucket" "state" {
  project  = var.project
  name     = var.bucket
  location = var.location

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  # Old versions of a state file are only for recovery.
  lifecycle_rule {
    condition {
      num_newer_versions = 20
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.storage]
}
