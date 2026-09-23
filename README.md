# Localflare

Localflare is becoming a headless local Cloudflare API emulator. **Checkpoints 1–9 are implemented.** Real clients can reach its identity API, deploy a Worker, and manage KV, D1, R2, Queues, zones, rulesets, and DNS without a Cloudflare account.

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

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler kv namespace create my-local-kv --update-config=false

# Use the namespace ID printed above.
CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler kv key put greeting hello \
  --namespace-id YOUR_NAMESPACE_ID --remote

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler d1 create my-local-db --update-config=false

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler d1 execute my-local-db \
  --remote --command 'SELECT 1 AS answer' --json

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler r2 bucket create my-local-bucket

CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788/client/v4 \
CLOUDFLARE_API_TOKEN=localflare-fake-token \
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000001 \
  ./node_modules/.bin/wrangler queues create my-local-queue

curl http://127.0.0.1:8788/client/v4/zones \
  -H 'Content-Type: application/json' \
  -d '{"account":{"id":"00000000000000000000000000000001"},"name":"example.test","type":"full"}'

# Use the zone ID returned above.
curl http://127.0.0.1:8788/client/v4/zones/YOUR_ZONE_ID/settings/always_use_https \
  -X PATCH -H 'Content-Type: application/json' -d '{"value":"on"}'
```

Checkpoint 1 serves `GET /user/tokens/verify`, `GET /user`, `GET /accounts`, and `GET /memberships` beneath `/client/v4`. Checkpoint 2 serves Workers script upload, download, list, and delete routes. Wrangler deploy uses a few additional service, version, and subdomain routes. The API accepts both module and service Worker syntax. Uploaded scripts run in workerd through Miniflare, and the local invocation path is `/__localflare/workers/:name/*` on the same port. The `workers.dev` URL printed by Wrangler is a compatibility response; use the local invocation path to call the Worker.

Checkpoint 3 serves namespace create/list/get/rename/delete and individual key put/get/list/delete under `/accounts/:id/storage/kv/namespaces`. KV values use Miniflare storage, including Worker `kv_namespace` bindings, binary values, metadata, expiration, and cursor listing. The official TypeScript SDK's flat multipart metadata fields are accepted. Bulk KV APIs are not implemented.

Checkpoint 4 serves D1 database create/list/get/update/delete and `POST /accounts/:id/d1/database/:uuid/query`. SQL runs in Miniflare's SQLite-backed D1, including parameterized queries and multiple semicolon-separated statements. Workers with a `d1` binding and the management API see the same database. Wrangler `d1 execute` must use `--remote`; its default `--local` mode uses Wrangler's own private database. The `--file` import flow, `/raw`, export, time travel, and replication are not implemented. `read_replication.mode` is stored as configuration only; no replicas are created.

Checkpoint 5 serves zone create/list/get/edit/delete and zone settings list/get/edit under `/zones`. Zone IDs are stable for the server lifetime and will be used by zone-scoped services in later checkpoints. New zones remain `pending` and have no real nameservers or DNS activation. Settings currently support `always_use_https`, `ssl`, `security_level`, and `min_tls_version`; their values are stored but do not change Worker traffic. The official TypeScript SDK and the real Terraform `cloudflare_zone` resource are verified against these routes.

Checkpoint 6 serves zone ruleset create/list/get/update/delete at `/zones/:zone_id/rulesets`. A real `cloudflare_ruleset` Terraform resource and the official TypeScript SDK are verified against these routes. The local evaluator applies zone entry point rulesets in `http_request_dynamic_redirect`, `http_request_transform`, then `http_request_firewall_custom` order. It supports static redirects, static path rewrites, block, and log. Expressions support `true`, `false`, parentheses, `and`/`or`/`not`, `starts_with`, and `eq`/`ne`/`contains` on `http.request.uri.path`, `http.request.method`, `http.host`, and `cf.zone.name`. Unsupported expressions and actions are rejected when written.

Rules are evaluated for requests to `/__localflare/workers/:name/*` when the HTTP `Host` header matches a local zone or one of its subdomains. For example, after creating a zone named `example.test` and a matching ruleset:

```sh
curl -H 'Host: example.test' http://127.0.0.1:8788/__localflare/workers/hello/example
```

Account rulesets, phase entry point convenience routes, individual rule and version routes, dynamic redirect/rewrite expressions, custom ruleset execution, and broader Rules language fields are not yet implemented. Custom rulesets can be stored, but only zone entry point rulesets affect local requests. Rule evaluation is limited to the local Worker invocation path; Localflare does not route arbitrary zone traffic or activate DNS.

Checkpoint 7 serves DNS record create/list/get/update/delete at `/zones/:zone_id/dns_records` and accepts cache purge requests at `/zones/:zone_id/purge_cache`. A, AAAA, CNAME, TXT, and MX records are stored in memory with name and TTL validation; CNAME conflicts are rejected. The official TypeScript SDK and a real Terraform `cloudflare_dns_record` resource are verified against these routes. Localflare does not run an authoritative DNS server or resolve these records for Worker traffic.

The purge endpoint accepts purge everything, URL files, tags, hosts, or prefixes and returns the documented request ID. Localflare has no CDN cache store, so it acknowledges a valid purge without evicting content. Purge calls do not clear Worker Cache API entries in Miniflare.

Checkpoint 8 serves R2 bucket create/list/get/delete under `/accounts/:id/r2/buckets` and a path-style S3 subset on the same port. S3 clients should use `http://127.0.0.1:8788` as the endpoint, region `auto`, path-style addressing, and any nonempty access key and secret. The verified S3 operations are ListBuckets, CreateBucket, DeleteBucket, ListObjectsV2, PutObject, GetObject, HeadObject, and DeleteObject. Objects are stored in Miniflare R2, and a deployed Worker's `r2_bucket` binding shares that data. Bucket deletion rejects nonempty buckets. Localflare accepts signed requests but does not validate SigV4 signatures. Multipart uploads, copy, tagging, presigned URL validation, virtual-hosted addressing, and the broader S3 protocol are not implemented; object request bodies are limited to 10 MiB.

Checkpoint 9 serves queue create/list/get/delete under `/accounts/:id/queues` and Worker consumer create/list/get/delete under `/accounts/:id/queues/:queue_id/consumers`. Wrangler `queues create` and the official TypeScript SDK have been verified against these routes. A deployed Worker can publish through a `queue` binding and consume messages through its `queue()` handler when producer and consumer run in the same Miniflare instance. Registering or removing a consumer updates that running Worker. Queue deletion is rejected while it has consumers or a deployed Worker producer binding. Separate Workers currently run in separate Miniflare instances, so messages are not delivered between them. Initial queue settings are stored but do not control delivery. HTTP pull consumers, message management endpoints, queue settings updates, and cross Worker delivery are not implemented.

The account identity is fixed for now. Worker scripts, Durable Object state, KV state, D1 databases, R2 buckets and objects, queue configuration, zones, rulesets, and DNS records are held for the life of the server and removed when it stops. Request bodies are limited to 10 MiB. Text and secret text bindings, local Durable Object bindings, KV, D1, R2, and Queue producer bindings, and initial `new_sqlite_classes` migrations are supported. Durable Object rename, delete, transfer, and cross Worker bindings are not implemented. See [POC.md](./POC.md) for the original checkpoint plan.

## Verify

```sh
npm run typecheck
npm test
npm run test:compat
```

The compatibility suite launches the pinned Wrangler binary, uses the official `cloudflare` TypeScript SDK and AWS S3 SDK, and runs Terraform with the real Cloudflare provider. It deploys and redeploys Workers, checks Durable Object state across redeploy, runs Wrangler KV, D1, R2, and Queues commands, verifies SDK operations, proves deployed Workers share KV, D1, and R2 state with the management API, checks same Worker Queue delivery, and applies then destroys Terraform zones, a ruleset, and a DNS record. Terraform must be installed separately. `terraform init` downloads the pinned provider when it is not cached. The suite starts Localflare on an ephemeral loopback port and supplies that port through each client's base URL override.

The Terraform fixture uses a synthetic 40 character token because the provider checks token format before making HTTP requests. No real credential is used.

See [compatibility evidence](./docs/conformance.md) for exact tested versions and scope.
