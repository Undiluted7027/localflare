# Compatibility evidence

This file distinguishes client behavior observed in a live test from API shapes taken from documentation. Run `npm run test:compat` to repeat the client checks.

| Claim | Status | Evidence |
| --- | --- | --- |
| Wrangler reads `CLOUDFLARE_API_BASE_URL` and accepts the local identity response | Verified against Wrangler 4.136.3 | `compat/clients.test.ts` invokes `wrangler whoami --json` with the override and checks the Localflare account ID. The command also calls `/user` and `/memberships`; both are implemented. |
| Official TypeScript SDK accepts `baseURL` and a fake bearer token | Verified against `cloudflare` 7.1.0 | The compatibility test calls `client.user.tokens.verify()` and `client.accounts.list()` against the local server. |
| Terraform provider accepts `base_url` and a fake bearer token | Verified against Cloudflare provider 5.24.0 with Terraform 1.15.3 | The compatibility test applies a `cloudflare_accounts` data source with `base_url` set to the local endpoint, then checks the output ID. The provider requires its dummy token to be 40 characters. |
| `GET /user/tokens/verify` returns an active token shape | Documented model, client acceptance verified | Cloudflare's [token verification example](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) shows `result.id`, `result.status`, `success`, `errors`, and `messages`; Wrangler and the SDK accept Localflare's response. No live comparison to Cloudflare's service was made. |
| `GET /accounts` returns an account list and pagination metadata | Documented model, client acceptance verified | Cloudflare's [accounts API documentation](https://developers.cloudflare.com/api/resources/accounts/methods/list/) describes the list endpoint; Wrangler, the SDK, and the Terraform provider accept Localflare's response. No live comparison to Cloudflare's service was made. |
| Workers, KV, D1, Rulesets, Zones, DNS, R2, and Queues management APIs | Not implemented | Later checkpoints in `POC.md`. |

This suite proves compatibility only for the calls listed above. It does not establish general compatibility with Wrangler, the SDK, or Terraform resources.
