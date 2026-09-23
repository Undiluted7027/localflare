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

resource "cloudflare_zone" "local" {
  account = {
    id = "00000000000000000000000000000001"
  }
  name = "terraform.example"
  type = "full"
}

output "zone_id" {
  value = cloudflare_zone.local.id
}
