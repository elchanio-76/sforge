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

# Not waiting for DNS: the records this module exports are read from this very
# resource, so it has to exist before they can be created.
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
  domain = one(google_firebase_hosting_custom_domain.this)

  # What Hosting wants published to serve the domain. A record marked REMOVE is
  # one Hosting found and wants gone, which is the zone owner's decision. The
  # certificate's ACME challenges are left out on purpose: Google describes them
  # as a way to get a certificate before pointing traffic at Hosting, and the
  # routing record goes out at the same time. Keeping them would also tie DNS to
  # a value Firebase changes on its own while the certificate is pending.
  wanted_records = local.domain == null ? [] : [
    for record in flatten([
      for update in local.domain.required_dns_updates : [for set in update.desired : set.records]
    ]) : record if record.required_action != "REMOVE"
  ]

  # A name can have several values, and a value can be listed twice: the key is
  # the whole record.
  dns_records = {
    for record in local.wanted_records :
    lower("${record.type}-${trimsuffix(record.domain_name, ".")}-${substr(sha256(record.rdata), 0, 8)}") => {
      name  = record.domain_name
      type  = record.type
      value = record.rdata
    }...
  }
}
