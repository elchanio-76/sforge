output "fqdns" {
  description = "Names of the records, e.g. for the certificate validation to wait on."
  value       = [for record in cloudflare_dns_record.this : record.name]
}

output "ids" {
  description = "Record IDs by key."
  value       = { for key, record in cloudflare_dns_record.this : key => record.id }
}
