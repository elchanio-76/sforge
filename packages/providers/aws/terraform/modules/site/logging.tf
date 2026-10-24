# Optional CloudFront standard (legacy) access logs. They are delivered with
# ACLs, so this bucket, unlike the content bucket, keeps ACLs enabled.

data "aws_canonical_user_id" "current" {
  count = var.logging ? 1 : 0
}

resource "aws_s3_bucket" "logs" {
  count         = var.logging ? 1 : 0
  bucket_prefix = "${trimsuffix(substr("sforge-${local.id}", 0, 31), "-")}-logs-"
  force_destroy = var.force_destroy
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "logs" {
  count                   = var.logging ? 1 : 0
  bucket                  = aws_s3_bucket.logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  count  = var.logging ? 1 : 0
  bucket = aws_s3_bucket.logs[0].id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "logs" {
  count  = var.logging ? 1 : 0
  bucket = aws_s3_bucket.logs[0].id

  access_control_policy {
    owner {
      id = data.aws_canonical_user_id.current[0].id
    }
    grant {
      permission = "FULL_CONTROL"
      grantee {
        type = "CanonicalUser"
        id   = data.aws_canonical_user_id.current[0].id
      }
    }
    grant {
      # The awslogsdelivery account, which writes CloudFront logs.
      permission = "FULL_CONTROL"
      grantee {
        type = "CanonicalUser"
        id   = "c4c1ede66af53448b93c283ce9448c4ba468c9432aa01d700d3878632f77d2d0"
      }
    }
  }

  depends_on = [aws_s3_bucket_ownership_controls.logs]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  count  = var.logging ? 1 : 0
  bucket = aws_s3_bucket.logs[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  count  = var.logging ? 1 : 0
  bucket = aws_s3_bucket.logs[0].id

  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}
