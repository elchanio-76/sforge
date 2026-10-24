output "bucket" {
  value = aws_s3_bucket.state.id
}

output "bucket_arn" {
  value = aws_s3_bucket.state.arn
}

output "region" {
  value = aws_s3_bucket.state.region
}
