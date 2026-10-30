# Plans and applies the module against mocked providers, so no Google Cloud
# project is needed. Run with `tofu test` (or `terraform test`).

mock_provider "google" {}

mock_provider "google-beta" {
  mock_resource "google_firebase_hosting_custom_domain" {
    defaults = {
      required_dns_updates = [{
        check_time = "2026-10-30T00:00:00Z"
        discovered = []
        desired = [
          {
            domain_name = "firebase.example.com"
            check_error = []
            records = [
              { domain_name = "firebase.example.com.", rdata = "199.36.158.100", required_action = "ADD", type = "A" },
              { domain_name = "firebase.example.com.", rdata = "hosting-site=docs-prod", required_action = "ADD", type = "TXT" },
              { domain_name = "firebase.example.com.", rdata = "hosting-site=docs-prod", required_action = "NONE", type = "TXT" },
              { domain_name = "firebase.example.com.", rdata = "203.0.113.9", required_action = "REMOVE", type = "A" },
            ]
          },
        ]
      }]
      cert = [{
        type  = "GROUPED"
        state = "CERT_PREPARING"
        verification = [{
          http = []
          dns = [{
            check_time = "2026-10-30T00:00:00Z"
            discovered = []
            desired = [
              {
                domain_name = "_acme-challenge.firebase.example.com"
                check_error = []
                records = [
                  { domain_name = "_acme-challenge.firebase.example.com.", rdata = "token", required_action = "ADD", type = "TXT" },
                  { domain_name = "_acme-challenge.firebase.example.com.", rdata = "token", required_action = "ADD", type = "TXT" },
                ]
              },
            ]
          }]
        }]
      }]
    }
  }
}

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
    error_message = "The records come from this resource, so it cannot wait for them."
  }
  assert {
    condition     = length(output.dns_records) == 2
    error_message = "The routing record and the ownership TXT: no REMOVE, no ACME challenge."
  }
  assert {
    condition     = length([for r in values(output.dns_records) : r if r.type == "A" && r.value == "199.36.158.100"]) == 1
    error_message = "The A record to add must be exported."
  }
  assert {
    condition     = length([for r in values(output.dns_records) : r if startswith(r.name, "_acme-challenge")]) == 0
    error_message = "ACME challenges are for moving a domain before its traffic, and they change."
  }
  assert {
    condition     = length([for r in values(output.dns_records) : r if r.value == "203.0.113.9"]) == 0
    error_message = "Records Hosting wants removed must not be created."
  }
}
