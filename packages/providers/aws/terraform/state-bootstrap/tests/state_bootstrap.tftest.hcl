mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  bucket_name = "sforge-state-123456789012-eu-central-1"
}

run "private_versioned_encrypted_bucket" {
  # plan: prevent_destroy would stop the test from cleaning up after an apply.
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "Block Public Access must be fully enabled."
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State versioning must be enabled."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.state.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "State must be encrypted with SSE-S3 by default."
  }
}

run "kms_encryption" {
  command = plan

  variables {
    kms_key_arn = "arn:aws:kms:eu-central-1:123456789012:key/abc"
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default).sse_algorithm == "aws:kms"
    error_message = "A KMS key must switch to SSE-KMS."
  }
}
