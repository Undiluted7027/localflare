# Localflare

Localflare is becoming a headless local Cloudflare API emulator. **Only checkpoint 1 is implemented.** It provides a local identity and account surface so real clients can reach the emulator without a Cloudflare account.

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
```

Checkpoint 1 currently serves `GET /user/tokens/verify`, `GET /user`, `GET /accounts`, and `GET /memberships` beneath `/client/v4`. The latter two identity routes are needed by the tested Wrangler version. The account and user identities are fixed local values; storage, Workers deployment, and other services belong to later checkpoints in [POC.md](./POC.md).

## Verify

```sh
npm run typecheck
npm test
npm run test:compat
```

The compatibility suite launches the pinned Wrangler binary, uses the official `cloudflare` TypeScript SDK, and runs Terraform with the real Cloudflare provider. Terraform must be installed separately. `terraform init` downloads the pinned provider when it is not cached. The suite starts Localflare on an ephemeral loopback port and supplies that port through each client's base URL override.

The Terraform fixture uses a synthetic 40 character token because the provider checks token format before making HTTP requests. No real credential is used.

See [compatibility evidence](./docs/conformance.md) for exact tested versions and scope.
