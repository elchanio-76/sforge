output "project" {
  description = "Google Cloud project of the site, once its APIs are on: what depends on them reads this."
  value       = var.project

  depends_on = [google_project_service.this]
}

output "site_id" {
  description = "Firebase Hosting site ID."
  value       = google_firebase_hosting_site.this.site_id
}

output "default_host_name" {
  description = "The site's own host name."
  value       = "${google_firebase_hosting_site.this.site_id}.web.app"
}

output "url" {
  description = "Where the site is served: the custom domain, or its own host name."
  value       = var.domain == null ? "https://${google_firebase_hosting_site.this.site_id}.web.app" : "https://${var.domain}"
}

output "domain" {
  description = "The custom domain, if any."
  value       = var.domain
}

output "dns_records" {
  description = "DNS records of the custom domain."
  value       = local.dns_records
}
