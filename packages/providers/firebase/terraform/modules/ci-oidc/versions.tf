terraform {
  required_version = ">= 1.10.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0, < 9.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6, < 4.0"
    }
  }
}
