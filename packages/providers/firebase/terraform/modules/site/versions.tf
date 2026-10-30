terraform {
  required_version = ">= 1.10.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0, < 9.0"
    }
    # Firebase's resources exist only in the beta provider.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.0, < 9.0"
    }
  }
}
