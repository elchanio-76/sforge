# Plans and applies the module against mocked providers, so no Google Cloud
# project is needed. Run with `tofu test` (or `terraform test`).

mock_provider "google" {
  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      name = "projects/123456/locations/global/workloadIdentityPools/sforge-pool"
    }
  }
  mock_resource "google_iam_workload_identity_pool_provider" {
    defaults = {
      name = "projects/123456/locations/global/workloadIdentityPools/sforge-pool/providers/github"
    }
  }
  mock_resource "google_service_account" {
    defaults = {
      name   = "projects/my-project/serviceAccounts/sforge-ci-test@my-project.iam.gserviceaccount.com"
      email  = "sforge-ci-test@my-project.iam.gserviceaccount.com"
      member = "serviceAccount:sforge-ci-test@my-project.iam.gserviceaccount.com"
    }
  }
}

mock_provider "random" {
  mock_resource "random_id" {
    defaults = {
      hex = "a1b2"
    }
  }
}

variables {
  name           = "docs"
  target         = "prod"
  project        = "my-project"
  repo           = "acme/docs"
  subject_prefix = "repo:acme@1001/docs@2002"
  branches       = ["main", "release/1.x"]
  environments   = ["production"]
  state_bucket   = "sforge-state-my-project"
  state_prefix   = "docs/prod"
}

run "only_the_repository_can_sign_in" {
  command = apply

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.sub.startsWith('repo:acme@1001/docs@2002:')"
    error_message = "The pool must accept only tokens of this repository."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    error_message = "Only GitHub's issuer."
  }
}

run "each_allowed_subject_is_named" {
  command = apply

  assert {
    condition     = length(google_service_account_iam_member.subject) == 4
    error_message = "Two branches, one environment and pull requests."
  }
  assert {
    condition     = contains(keys(google_service_account_iam_member.subject), "repo:acme@1001/docs@2002:ref:refs/heads/main")
    error_message = "The main branch may deploy."
  }
  assert {
    condition     = contains(keys(google_service_account_iam_member.subject), "repo:acme@1001/docs@2002:environment:production")
    error_message = "The environment may deploy."
  }
  assert {
    condition     = alltrue([for m in google_service_account_iam_member.subject : startswith(m.member, "principal://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/sforge-pool/subject/")])
    error_message = "Members are exact subjects in this pool, never a whole pool."
  }
}

run "pull_requests_can_be_left_out" {
  command = plan

  variables {
    pull_requests = false
  }

  assert {
    condition     = !contains(keys(google_service_account_iam_member.subject), "repo:acme@1001/docs@2002:pull_request")
    error_message = "Pull requests were not allowed."
  }
}

run "the_identity_is_minimal" {
  command = apply

  assert {
    condition     = google_project_iam_member.hosting.role == "roles/firebasehosting.admin"
    error_message = "CI needs Hosting, and nothing else on the project."
  }
  assert {
    condition     = google_storage_bucket_iam_member.state.role == "roles/storage.objectViewer"
    error_message = "CI only reads state."
  }
  assert {
    condition     = strcontains(google_storage_bucket_iam_member.state.condition[0].expression, "objects/docs/prod/")
    error_message = "CI reads only its own target's state."
  }
}

run "outputs_for_the_workflows" {
  command = apply

  assert {
    condition     = output.workload_identity_provider == "projects/123456/locations/global/workloadIdentityPools/sforge-pool/providers/github"
    error_message = "google-github-actions/auth needs the full name."
  }
  assert {
    condition     = output.service_account == "sforge-ci-test@my-project.iam.gserviceaccount.com"
    error_message = "google-github-actions/auth needs the email."
  }
}
