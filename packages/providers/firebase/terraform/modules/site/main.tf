# A Firebase Hosting site in an existing Google Cloud project, and its custom
# domain. Deploys are not Terraform's business: versions, releases and preview
# channels are made through the Hosting REST API.

locals {
  # disable_on_destroy is off: other things in the project may use these APIs,
  # and turning them off can break them.
  services = toset([
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "serviceusage.googleapis.com",
  ])
}

resource "google_project_service" "this" {
  for_each = local.services

  project            = var.project
  service            = each.value
  disable_on_destroy = false
}

# Adding Firebase is permanent, so destroying this only forgets it. A project
# that already uses Firebase is adopted with an import block (see src/iac.ts).
resource "google_firebase_project" "this" {
  provider = google-beta

  project = var.project

  depends_on = [google_project_service.this]
}

resource "google_firebase_hosting_site" "this" {
  provider = google-beta

  project = var.project
  site_id = var.site_id

  depends_on = [google_firebase_project.this]
}

# Not waiting for DNS here: the certificate can take over half an hour, and
# provision checks the domain itself afterwards, with a useful message.
resource "google_firebase_hosting_custom_domain" "this" {
  count    = var.domain == null ? 0 : 1
  provider = google-beta

  project       = var.project
  site_id       = google_firebase_hosting_site.this.site_id
  custom_domain = var.domain

  cert_preference       = "GROUPED"
  wait_dns_verification = false
}

locals {
  # The record is computed rather than read from required_dns_updates: Firebase
  # stops listing it there once the domain is active, and following that list
  # would delete the live site's record on the next apply. A subdomain needs only
  # this CNAME: it proves ownership, and the certificate follows without the ACME
  # challenges, which are for moving a domain before its traffic.
  dns_records = var.domain == null ? {} : {
    routing = {
      name  = var.domain
      type  = "CNAME"
      value = "${var.site_id}.web.app"
    }
  }
}
