terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.24.0"
    }
  }
}

provider "cloudflare" {
  api_token = "0000000000000000000000000000000000000000"
  base_url  = "LOCALFLARE_BASE_URL"
}

data "cloudflare_accounts" "local" {
  name = "Localflare"
}

output "account_id" {
  value = data.cloudflare_accounts.local.result[0].id
}
