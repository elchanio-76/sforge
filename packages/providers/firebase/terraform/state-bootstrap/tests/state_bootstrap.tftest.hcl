# Plans and applies the module against a mocked provider, so no Google Cloud
# project is needed. Run with `tofu test` (or `terraform test`).

mock_provider "google" {
  mock_data "google_client_openid_userinfo" {
    defaults = {
      email = "owner@example.com"
    }
  }
}

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

run "a_user_gets_access_to_the_objects" {
  command = plan

  assert {
    condition     = google_storage_bucket_iam_member.caller.member == "user:owner@example.com"
    error_message = "The caller is a user."
  }
  assert {
    condition     = google_storage_bucket_iam_member.caller.role == "roles/storage.objectAdmin"
    error_message = "The caller needs to read and write objects."
  }
}

run "a_service_account_gets_access_too" {
  command = plan

  override_data {
    target = data.google_client_openid_userinfo.caller
    values = {
      email = "deploy@my-project.iam.gserviceaccount.com"
    }
  }

  assert {
    condition     = google_storage_bucket_iam_member.caller.member == "serviceAccount:deploy@my-project.iam.gserviceaccount.com"
    error_message = "The caller is a service account."
  }
}
