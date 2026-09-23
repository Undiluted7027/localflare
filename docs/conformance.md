# Compatibility evidence

This file distinguishes client behavior observed in a live test from API shapes taken from documentation. Run `npm run test:compat` to repeat the client checks.

| Claim | Status | Evidence |
| --- | --- | --- |
| Wrangler reads `CLOUDFLARE_API_BASE_URL` and accepts the local identity response | Verified against Wrangler 4.136.3 | `compat/clients.test.ts` invokes `wrangler whoami --json` with the override and checks the Localflare account ID. The command also calls `/user` and `/memberships`; both are implemented. |
| Official TypeScript SDK accepts `baseURL` and a fake bearer token | Verified against `cloudflare` 7.1.0 | The compatibility test calls `client.user.tokens.verify()` and `client.accounts.list()` against the local server. |
| Terraform provider accepts `base_url` and a fake bearer token | Verified against Cloudflare provider 5.24.0 with Terraform 1.15.3 | The compatibility test applies a `cloudflare_accounts` data source with `base_url` set to the local endpoint, then checks the output ID. The provider requires its dummy token to be 40 characters. |
| `wrangler deploy` uploads and redeploys a module Worker | Verified against Wrangler 4.136.3 | The compatibility test runs the real command twice, then invokes the uploaded Worker through Miniflare/workerd. It covers a simple module Worker without resource bindings. |
| Wrangler deploys a Worker with a local Durable Object and `new_sqlite_classes` migration | Verified against Wrangler 4.136.3 | The compatibility test deploys a class binding, invokes it twice, redeploys, and observes the next stored count. Rename, delete, transfer, and cross Worker bindings are not verified or implemented. |
| Workers script list, download, update, and delete | Verified against `cloudflare` 7.1.0 | The compatibility test uses the official SDK for each operation after Wrangler deploy and invokes the updated Worker. The SDK's multipart upload format is accepted alongside Wrangler's. |
| Service Worker syntax and failed replacement behavior | Verified locally | `test/server.test.ts` uploads a classic Worker and runs it, and verifies that an invalid replacement leaves the prior Worker available. These cases have not been exercised through an official client. |
| `GET /user/tokens/verify` returns an active token shape | Documented model, client acceptance verified | Cloudflare's [token verification example](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) shows `result.id`, `result.status`, `success`, `errors`, and `messages`; Wrangler and the SDK accept Localflare's response. No live comparison to Cloudflare's service was made. |
| `GET /accounts` returns an account list and pagination metadata | Documented model, client acceptance verified | Cloudflare's [accounts API documentation](https://developers.cloudflare.com/api/resources/accounts/methods/list/) describes the list endpoint; Wrangler, the SDK, and the Terraform provider accept Localflare's response. No live comparison to Cloudflare's service was made. |
| KV, D1, Rulesets, Zones, DNS, R2, and Queues management APIs | Not implemented | Later checkpoints in `POC.md`. |

The Workers deployment flow also answers Wrangler's service metadata, version, deployment, and subdomain requests. Version and deployment history are currently minimal compatibility responses; the script content and running Worker reflect the latest upload. The displayed `workers.dev` URL is not a routable endpoint. Text and secret text bindings and local Durable Objects with initial SQLite class migrations are supported. Worker scripts and Durable Object state disappear on restart.

This suite proves compatibility only for the calls listed above. It does not establish general compatibility with Wrangler, the SDK, or Terraform resources.
