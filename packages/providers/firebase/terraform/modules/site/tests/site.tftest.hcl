# Plans and applies the module against mocked providers, so no Google Cloud
# project is needed. Run with `tofu test` (or `terraform test`).

mock_provider "google" {}

mock_provider "google-beta" {}

variables {
  project = "my-project"
  site_id = "docs-prod"
}

run "a_site_on_its_own_host_name" {
  command = apply

  assert {
    condition     = output.url == "https://docs-prod.web.app"
    error_message = "Without a domain the site is served from web.app."
  }
  assert {
    condition     = length(google_firebase_hosting_custom_domain.this) == 0
    error_message = "No domain was asked for."
  }
  assert {
    condition     = length(output.dns_records) == 0
    error_message = "No domain, no records."
  }
  assert {
    condition     = alltrue([for service in google_project_service.this : !service.disable_on_destroy])
    error_message = "Destroying a site must not turn off APIs other things may use."
  }
  assert {
    condition     = contains(keys(google_project_service.this), "firebasehosting.googleapis.com")
    error_message = "The Hosting API must be enabled."
  }
}

run "a_custom_domain_exports_its_records" {
  command = apply

  variables {
    domain = "firebase.example.com"
  }

  assert {
    condition     = output.url == "https://firebase.example.com"
    error_message = "With a domain the site is served from it."
  }
  assert {
    condition     = google_firebase_hosting_custom_domain.this[0].cert_preference == "GROUPED"
    error_message = "A grouped certificate is what the free tier gets."
  }
  assert {
    condition     = !google_firebase_hosting_custom_domain.this[0].wait_dns_verification
    error_message = "Provision does the waiting: it can say something useful when it takes long."
  }
  assert {
    condition     = output.dns_records.routing.type == "CNAME" && output.dns_records.routing.name == "firebase.example.com"
    error_message = "The domain needs a CNAME."
  }
  assert {
    condition     = output.dns_records.routing.value == "docs-prod.web.app"
    error_message = "The CNAME points at the site's own host name."
  }
  assert {
    condition     = length(output.dns_records) == 1
    error_message = "Only the routing record: no ACME challenge, nothing read from Firebase."
  }
}
