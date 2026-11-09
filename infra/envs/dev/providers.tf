provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

/**
 * us-east-1 is required by AWS for two CloudFront-adjacent resource types:
 * CLOUDFRONT-scoped WAF web ACLs and ACM certificates used by a distribution.
 * Nothing else may use this provider.
 */
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}
