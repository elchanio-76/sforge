# Plans the module against a mocked provider, so no Google Cloud project is
# needed. Run with `tofu test` (or `terraform test`).

mock_provider "google" {}

variables {
  project = "my-project"
  bucket  = "sforge-state-my-project"
}

# plan, not apply: prevent_destroy would stop the test from cleaning up.
run "the_bucket_is_private_versioned_and_kept" {
  command = plan

  assert {
    condition     = google_storage_bucket.state.public_access_prevention == "enforced"
    error_message = "Public access must be prevented."
  }
  assert {
    condition     = google_storage_bucket.state.uniform_bucket_level_access
    error_message = "Access must be uniform: no object ACLs."
  }
  assert {
    condition     = google_storage_bucket.state.versioning[0].enabled
    error_message = "State must be versioned."
  }
  assert {
    condition     = google_storage_bucket.state.location == "EU"
    error_message = "The default location is EU."
  }
}

run "the_location_can_be_chosen" {
  command = plan

  variables {
    location = "europe-north1"
  }

  assert {
    condition     = google_storage_bucket.state.location == "europe-north1"
    error_message = "The configured location must be used."
  }
}
