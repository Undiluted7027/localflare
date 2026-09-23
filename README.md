# Localflare

Localflare is becoming a headless local Cloudflare API emulator. **Checkpoints 1 and 2 are implemented.** Real clients can reach its identity API and deploy a Worker without a Cloudflare account.

## Run

Requires Node.js 24 or later. Install dependencies and start the server:

```sh
npm install
npm start
```

The server listens on `http://127.0.0.1:8788/client/v4` by default. Set `PORT` to use another port. Port 8788 is one above Wrangler's common local Worker port, 8787, so the two can run together during later checkpoints.

No token is needed for direct HTTP calls. Clients that require a token locally can use any token they accept syntactically:

```sh
curl http://127.0.0.1:8788/client/v4/accounts

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
  ./node_modules/.bin/wrangler whoami

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler deploy compat/workers/hello.js \
  --name hello --compatibility-date 2025-07-18 --no-autoconfig

curl http://127.0.0.1:8788/__localflare/workers/hello/example

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler deploy \
  --config compat/workers/durable/wrangler.jsonc --no-autoconfig

curl http://127.0.0.1:8788/__localflare/workers/durable-counter/
```

Checkpoint 1 serves `GET /user/tokens/verify`, `GET /user`, `GET /accounts`, and `GET /memberships` beneath `/client/v4`. Checkpoint 2 serves Workers script upload, download, list, and delete routes. Wrangler deploy uses a few additional service, version, and subdomain routes. The API accepts both module and service Worker syntax. Uploaded scripts run in workerd through Miniflare, and the local invocation path is `/__localflare/workers/:name/*` on the same port. The `workers.dev` URL printed by Wrangler is a compatibility response; use the local invocation path to call the Worker.

The account identity is fixed for now. Worker scripts and Durable Object state are held for the life of the server and removed when it stops. Request bodies are limited to 10 MiB. Text and secret text bindings, local Durable Object bindings, and initial `new_sqlite_classes` migrations are supported. Durable Object rename, delete, transfer, and cross Worker bindings are not implemented. Other services belong to later checkpoints in [POC.md](./POC.md).

## Verify

```sh
npm run typecheck
npm test
npm run test:compat
```

The compatibility suite launches the pinned Wrangler binary, uses the official `cloudflare` TypeScript SDK, and runs Terraform with the real Cloudflare provider. It deploys and redeploys a Worker, invokes it locally, checks Durable Object state across redeploy, and uses the SDK to list, download, update, and delete a script. Terraform must be installed separately. `terraform init` downloads the pinned provider when it is not cached. The suite starts Localflare on an ephemeral loopback port and supplies that port through each client's base URL override.

The Terraform fixture uses a synthetic 40 character token because the provider checks token format before making HTTP requests. No real credential is used.

See [compatibility evidence](./docs/conformance.md) for exact tested versions and scope.
