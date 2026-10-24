locals {
  id = "${var.name}-${var.target}"
  # bucket_prefix may be at most 37 characters; a random suffix makes the name unique.
  bucket_prefix = "${trimsuffix(substr("sforge-${local.id}", 0, 36), "-")}-"
  tags          = merge(var.tags, { "sforge:site" = var.name, "sforge:target" = var.target })
}

# Private content bucket. Deploys write v/<versionId>/...; there is no website
# endpoint and no public access: only this distribution can read it (OAC).
resource "aws_s3_bucket" "site" {
  bucket_prefix = local.bucket_prefix
  force_destroy = var.force_destroy
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Deploy prefixes beyond retainVersions are deleted by sforge; this only
# cleans up overwritten object versions and failed uploads.
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.site]
}

locals {
  cloudfront_only = {
    StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = local.cloudfront_only
      },
      {
        # Lets S3 answer 404 (not 403) for missing objects.
        Sid       = "CloudFrontList"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.site.arn
        Condition = local.cloudfront_only
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.site]
}
