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
  account = { id = "00000000000000000000000000000001" }
  name    = "terraform-dns.example"
  type    = "full"
}

resource "cloudflare_dns_record" "www" {
  zone_id = cloudflare_zone.local.id
  name    = "www"
  content = "192.0.2.FINAL_OCTET"
  type    = "A"
  ttl     = 1
  proxied = true
  comment = "Created by Terraform"
}

output "zone_id" {
  value = cloudflare_zone.local.id
}

output "dns_record_id" {
  value = cloudflare_dns_record.www.id
}
