# GitHub Actions deploy role, assumed through OIDC (no long-lived keys). The
# trust policy accepts only the configured branches, environments and, if
# enabled, pull_request workflows of one repository.

locals {
  ci        = var.ci
  ci_create = local.ci != null && try(local.ci.create_oidc_provider, false)
  ci_subjects = local.ci == null ? [] : concat(
    [for branch in local.ci.branches : "repo:${local.ci.repo}:ref:refs/heads/${branch}"],
    [for environment in local.ci.environments : "repo:${local.ci.repo}:environment:${environment}"],
    local.ci.pull_requests ? ["repo:${local.ci.repo}:pull_request"] : [],
  )
  oidc_provider_arn = local.ci == null ? null : (
    local.ci_create ? aws_iam_openid_connect_provider.github[0].arn : local.ci.oidc_provider_arn
  )
  state_bucket = local.ci == null ? "" : (local.ci.state_bucket == null ? "" : local.ci.state_bucket)
  state_key    = local.ci == null ? "" : (local.ci.state_key == null ? "" : local.ci.state_key)
  state_object = "arn:aws:s3:::${local.state_bucket}/${local.state_key}"
  # This target's state (and its lock file) only, for `sforge status` and plans in CI.
  state_statements = [for statement in [
    {
      Sid       = "ListState"
      Effect    = "Allow"
      Action    = "s3:ListBucket"
      Resource  = "arn:aws:s3:::${local.state_bucket}"
      Condition = { StringLike = { "s3:prefix" = [local.state_key, "${local.state_key}.tflock"] } }
    },
    {
      Sid      = "ReadWriteState"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = [local.state_object, "${local.state_object}.tflock"]
    },
    {
      Sid      = "UnlockState"
      Effect   = "Allow"
      Action   = "s3:DeleteObject"
      Resource = "${local.state_object}.tflock"
    },
  ] : statement if local.state_bucket != ""]
}

# One per account. sforge reuses an existing provider and creates one (tagged
# with this site and target) only when the account has none.
resource "aws_iam_openid_connect_provider" "github" {
  count          = local.ci_create ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = merge(local.tags, { "sforge:owner" = local.id })
}

resource "aws_iam_role" "ci" {
  count                = local.ci == null ? 0 : 1
  name                 = substr("sforge-${local.id}-deploy", 0, 64)
  description          = "staticforge: GitHub Actions deploys of ${local.id} (${local.ci.repo})"
  max_session_duration = 3600
  tags                 = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = local.ci_subjects }
      }
    }]
  })
}

resource "aws_iam_role_policy" "ci" {
  count = local.ci == null ? 0 : 1
  name  = "deploy"
  role  = aws_iam_role.ci[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "ListContent"
          Effect   = "Allow"
          Action   = "s3:ListBucket"
          Resource = aws_s3_bucket.site.arn
        },
        {
          Sid      = "WriteContent"
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
          Resource = "${aws_s3_bucket.site.arn}/*"
        },
        {
          Sid    = "SwitchVersions"
          Effect = "Allow"
          Action = [
            "cloudfront-keyvaluestore:DescribeKeyValueStore",
            "cloudfront-keyvaluestore:GetKey",
            "cloudfront-keyvaluestore:ListKeys",
            "cloudfront-keyvaluestore:PutKey",
            "cloudfront-keyvaluestore:DeleteKey",
            "cloudfront-keyvaluestore:UpdateKeys",
          ]
          Resource = aws_cloudfront_key_value_store.site.arn
        },
        {
          Sid      = "Invalidate"
          Effect   = "Allow"
          Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation", "cloudfront:GetDistribution"]
          Resource = aws_cloudfront_distribution.site.arn
        },
      ],
      local.state_statements,
    )
  })
}
