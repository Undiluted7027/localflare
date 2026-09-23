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
  name    = "ruleset.example"
  type    = "full"
}

resource "cloudflare_ruleset" "firewall" {
  zone_id     = cloudflare_zone.local.id
  name        = "Local firewall"
  description = "Test the local ruleset"
  kind        = "zone"
  phase       = "http_request_firewall_custom"
  rules = [{
    ref         = "block_target"
    description = "Block target path"
    expression  = "(http.request.uri.path eq \"/BLOCK_PATH\")"
    action      = "block"
  }]
}

output "zone_id" {
  value = cloudflare_zone.local.id
}

output "ruleset_id" {
  value = cloudflare_ruleset.firewall.id
}
