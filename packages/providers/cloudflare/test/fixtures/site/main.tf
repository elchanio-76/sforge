# A stand-in for a site module: outputs records for the DNS modules and waits
# on the validation records they create, like the AWS certificate does.

variable "domain" {
  type = string
}

variable "validation_record_fqdns" {
  type    = list(string)
  default = []
}

resource "terraform_data" "certificate" {
  input = "_abc.${var.domain}."
}

resource "terraform_data" "validation" {
  input = var.validation_record_fqdns
}

resource "terraform_data" "distribution" {
  input      = "d111111abcdef8.cloudfront.net"
  depends_on = [terraform_data.validation]
}

output "validation_records" {
  value = {
    (var.domain) = { name = terraform_data.certificate.output, type = "CNAME", value = "_def.acm-validations.aws." }
  }
}

output "dns_records" {
  value = {
    (var.domain) = { name = var.domain, type = "CNAME", value = terraform_data.distribution.output }
  }
}
