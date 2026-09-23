# Localflare: the floci of Cloudflare

Localflare's direction has changed. The original POC (preserved in git history) was a teaching sandbox: a dashboard, two emulated visitors, and a guided walkthrough of three failure modes. That version is real and it works — see `README.md` for what's actually running today. But it isn't the goal anymore.

The goal now is [floci](https://github.com/floci-io/floci): "any cloud, locally" for Cloudflare instead of AWS. Floci is a free, open-source, headless local AWS emulator — no dashboard, no curated demo, no account, no auth token. You point the real AWS CLI, SDKs, Terraform, and CDK at `http://localhost:4566` and they work unmodified, because Floci speaks AWS's actual wire protocol. That's the bar. Localflare should become the same thing for Cloudflare: a single local endpoint that `wrangler`, the Cloudflare Terraform provider, and the official Cloudflare SDKs can point at and just work, with no code changes and no Cloudflare account.

This document replaces the old POC.md as the north star. It is a plan, not a shipped product — treat every "supported" claim below as a target with a checkpoint attached, not a status report.

## Why this shift

The teaching-sandbox version answered "can someone understand what happened to their request." That's a good product, but it's a narrow one — one sample app, two visitors, a fixed topology. It doesn't get bigger by adding more services; it gets bigger by adding more guided narrative, which doesn't compound.

A wire-compatible emulator gets bigger by adding API surface, and every addition is independently useful the moment it lands — a developer who only needs local KV doesn't have to wait for D1 support to be "done." That's the floci model, and it's why floci-family projects (floci, floci-az, floci-gcp, floci-oci) can each grow service-by-service without a redesign. Localflare should adopt the same shape.

## What already carries over

The teaching-sandbox build wasn't wasted effort — most of its hard parts are exactly what a wire-compatible emulator needs underneath:

| Existing piece | Role in the new direction |
|---|---|
| `apps/worker` + Miniflare/workerd integration (`apps/server/src/runtime.ts`) | The actual Workers runtime. This is the single hardest thing floci-style projects build themselves (see floci's "Real Docker Integration" — Lambda, RDS, etc.), and Cloudflare already ships it as an embeddable library. `wrangler dev` already works fully locally for exactly this reason; the gap is everything *around* `dev` — deploy, list, KV/D1/R2 management — which currently has no local target. |
| D1 and KV bindings, already real (SQLite-backed D1, in-memory/persisted KV via Miniflare) | Directly reusable as the backing store behind a real D1/KV management API, once that API exists. |
| `packages/rule-engine` (rewrite-phase-before-custom-phase evaluation, block/redirect/log actions) | This already mirrors Cloudflare's real Rulesets Engine phase model (`http_request_dynamic_redirect` / URL rewrites run before `http_request_firewall_custom`). It's the evaluation core the real Rulesets API needs behind it — see "Supported services" and checkpoint 6 below. |
| `packages/shared`'s Zod-schema-as-source-of-truth pattern | The right tool for validating requests against Cloudflare's actual JSON shapes, the same role Zod already plays for our own bespoke schemas. |
| The monorepo, TypeScript strictness, test-first habits, honesty docs (`docs/conformance.md`, `docs/network-simulation.md`) | Keep all of it. A compatibility-claiming project has a *higher* bar for "documented model" vs. "verified against the real thing," not a lower one — see "Compatibility testing" below. |

## What changes

- **The dashboard stops being the product.** It becomes optional, the way floci's web console is: not started by default, not required for the emulator to work, and if it survives at all, it's a sidecar you can swap out — not core plumbing anything else depends on. The event-observability model underneath it (`packages/shared`'s typed events, the WebSocket feed) is still useful for an optional inspector; it just can't gate anything else being usable headlessly.
- **The bespoke REST API goes away.** `/api/rules`, `/api/firewall`, `/api/link`, `/api/experiments` were designed for a dashboard driving a fixed two-visitor topology. A real tool doesn't know that API exists and never will. It knows Cloudflare's actual `client/v4` shapes. The control plane gets rebuilt against *those*, not redesigned bespoke ones.
- **Two emulated visitors and a fixed topology go away.** Wire compatibility means arbitrary callers on arbitrary accounts/zones, not two named actors in a walkthrough.
- **The packet-firewall/Mininet/P4 question is no longer the interesting problem.** It was central to the old demo ("watch a rule miss, watch a packet drop"); it's a minor, low-priority corner of WAF/custom-rules compatibility in the new one. Don't carry the old urgency about it forward.
- **"One compelling demo" stops being the success metric.** The success metric becomes the one floci actually reports: how many real SDK/CLI/IaC calls succeed unmodified against the local endpoint.

## What "drop-in compatible" means here

Cloudflare's management API is REST under `https://api.cloudflare.com/client/v4`, authenticated with `Authorization: Bearer <token>` (or the legacy `X-Auth-Email`/`X-Auth-Key` pair), and every response is wrapped in the same envelope:

```json
{ "success": true, "errors": [], "messages": [], "result": { ... }, "result_info": { ... } }
```

Being a drop-in local target means an emulator serving that exact shape at a local port, with:

- **`wrangler`** pointed at it via `CLOUDFLARE_API_BASE_URL` (the env var wrangler reads instead of the real API base — treat this as a documented model to verify against a real `wrangler` binary in checkpoint 1, not an assumed fact; see "Compatibility testing").
- **The official Cloudflare Terraform provider** pointed at it via the provider's `base_url` field, so `terraform apply` against local Localflare provisions local resources with zero HCL changes beyond that one field.
- **The official SDKs** (`cloudflare` on npm, `cloudflare-go`, `cloudflare-python`, others) pointed at it via each SDK's base-URL override.
- **Plain `curl`**, for anyone who wants the API directly.

A fake, made-up bearer token should always succeed against local Localflare — same as floci's AWS credentials being any non-empty string. No account, no real Cloudflare login, ever required for local use.

## Supported services (target)

Mirroring floci's "Supported Services" table — status is honest about what's real today vs. planned, not aspirational:

| Service | Backing | Status |
|---|---|---|
| Workers (script CRUD, deploy) | workerd via Miniflare — real | `wrangler dev` already fully local; deploy/list/delete API not yet built |
| KV (namespaces, key-value CRUD) | Miniflare KV namespace — real | Bindings work inside a running Worker; standalone management API not yet built |
| D1 (database CRUD, query API) | Miniflare D1 (SQLite) — real | Bindings work inside a running Worker; standalone management API not yet built |
| R2 (bucket + object CRUD) | Miniflare documents an R2 simulator, and R2's actual wire protocol is S3-compatible (SigV4-authenticated) — a real advantage, since R2 objects wouldn't need a bespoke protocol reimplementation, just an S3-compatible surface. **Not yet exercised in this codebase** — treat as a documented model until checkpoint 8 verifies it. | Not yet built |
| Durable Objects | Miniflare documents DO support. **Not yet exercised in this codebase.** | Not yet built; no standalone management API planned yet (see below) |
| Queues | Miniflare documents a Queues simulator. **Not yet exercised in this codebase.** | Not yet built |
| Rulesets / WAF custom rules / URL rewrites | `packages/rule-engine` — real evaluation logic, wrong wire shape | Evaluation engine exists; needs to speak the real Rulesets API (`/zones/:id/rulesets`, phase names like `http_request_firewall_custom`) instead of `/api/rules` |
| Zones (create/list, zone settings) | — | Not yet built; needed as the account/zone identity every other endpoint hangs off of |
| DNS records | — | Not yet built |
| Cache purge | — | Not yet built |
| Access / Zero Trust, Images, Stream, Workers AI, Vectorize, Analytics Engine, Pages | — | Out of scope for now — large, identity-heavy, or low-value for a local dev loop. Revisit after the core surface above is solid, the same way floci grew from S3/DynamoDB/Lambda outward rather than starting broad. |

## Architecture (target)

```
Wrangler / Terraform / Cloudflare SDK / curl
        |  HTTP, client/v4 wire shapes, Bearer auth
        v
   HTTP Router  (Cloudflare API envelope: success/errors/messages/result)
        |
        +--> Workers control plane  --> workerd via Miniflare       [verified in this repo]
        +--> KV control plane       --> Miniflare KV                [verified in this repo]
        +--> D1 control plane       --> Miniflare D1 (SQLite)        [verified in this repo]
        +--> Rulesets control plane --> packages/rule-engine         [real logic, new wire shape]
        +--> R2 control plane       --> Miniflare R2, S3-compatible surface [documented, unverified]
        +--> Queues control plane   --> Miniflare Queues              [documented, unverified]
        +--> Zones / DNS / cache    --> in-process store               [new]
```

One process, one port (floci uses `4566`; Localflare needs its own memorable, unclaimed port — pick this deliberately in checkpoint 1, don't default to Cloudflare's own `443`). Everything under it is either a real Cloudflare-authored runtime component (workerd) or an in-process store, same as floci's stateless/stateful service split.

## Checkpoints

Rebuilt around API-surface breadth, not demo narrative. Each checkpoint should leave something a real tool can already talk to.

| # | Deliverable | Proves |
|---|---|---|
| 1 | `GET /client/v4/user/tokens/verify` and `GET /client/v4/accounts` respond correctly against a real `wrangler whoami` (or equivalent minimal SDK call) pointed at `CLOUDFLARE_API_BASE_URL=http://localhost:<port>/client/v4` | The wire envelope, auth stubbing, and the override hook point are all real, not assumed |
| 2 | Workers script CRUD (`PUT`/`GET`/`DELETE /accounts/:id/workers/scripts/:name`) backed by the existing Miniflare integration; `wrangler deploy` succeeds locally | The highest-value single surface — most other checkpoints are "management API for a thing `wrangler dev` already runs locally" |
| 3 | KV namespace + key-value CRUD; `wrangler kv namespace create` / `wrangler kv key put` succeed locally | First fully independent, non-Workers-specific service |
| 4 | D1 database CRUD + query endpoint; `wrangler d1 create` / `wrangler d1 execute` succeed locally | Reuses existing D1 binding work almost directly |
| 5 | Zones (create/list, zone settings) | Account-scoped services (2–4) are done; zone-scoped ones (6–7) need this first — Rulesets, DNS, and cache purge all hang off a zone id, so this has to land before them, not after |
| 6 | Rulesets API (real wire shape) backed by `packages/rule-engine`; a real `cloudflare_ruleset` Terraform resource applies locally | Proves the existing rule-engine work transfers, and proves Terraform provider compatibility, not just SDK/CLI |
| 7 | DNS records + cache purge | Rounds out the zone-scoped surface most IaC workflows also touch, alongside checkpoint 6 |
| 8 | R2 bucket + object CRUD via the S3-compatible surface | Proves the "reuse an existing protocol" bet pays off |
| 9 | Queues management API (create/list/delete queue, consumers); `wrangler queues create` succeeds locally | Last of the "Supported services" table's real-but-unbuilt rows |

Durable Objects deliberately has no checkpoint of its own: unlike KV/D1/R2/Queues, Cloudflare's DO management surface beyond Workers script deploy config (namespace bindings, migrations) is thin, so it rides along with checkpoint 2's Workers script CRUD rather than needing standalone endpoints. Revisit if that turns out to be wrong once checkpoint 2 is underway.

Treat this as an ordered backlog, not a calendar — same caveat the old POC.md carried, still true.

## Compatibility testing

Floci's credibility claim is backed by 2,576 automated tests running real SDKs, the real CLI, and real Terraform/OpenTofu against a running Floci instance (`compatibility-tests/` in their repo) — not "we implemented the spec," but "the actual client library round-trips against us." Localflare needs the same discipline from checkpoint 1 onward:

- A `compat/` (or similarly named) test suite that runs the **real** `wrangler` binary, the **real** `cloudflare` npm/Go/Python SDK, and the **real** Terraform `cloudflare` provider against a locally running Localflare instance, asserting on their actual output — not against our own mocked expectations of what they'd do.
- Every "documented model" claim in this file (the `CLOUDFLARE_API_BASE_URL` env var, the Terraform provider's `base_url` field, specific endpoint shapes) gets verified against the real tool before checkpoint 1 is called done, and the verification result — pass or fail — gets written down, the same way the old POC.md's conformance table distinguished "documented model" from "live comparison passed." Don't let an assumption about wrangler's internals quietly become load-bearing without ever having run wrangler.

## What "finished" looks like for the core surface

- Someone can `docker compose up` (or `pnpm start`, if a container isn't the first packaging step) with no Cloudflare account, get a local endpoint, and point real `wrangler`/Terraform/an official SDK at it via that tool's normal override mechanism — no fork, no patched client.
- `wrangler deploy`, `wrangler kv`, `wrangler d1`, and a `cloudflare_ruleset` Terraform resource all succeed against local Localflare, unmodified, and the compat suite proves it on every change.
- A fake bearer token always works; there is no real Cloudflare account anywhere in the local loop.
- Every claim of "matches Cloudflare's real API" is either backed by a passing compat-suite run against the real tool, or explicitly marked as an unverified documented model — never silently assumed.

## Explicitly deferred, not abandoned

The teaching-sandbox demo — the dashboard, the two visitors, the rule-order-mistake walkthrough, the packet-drop-vs-HTTP-block distinction, save/replay — is real, working code (see `README.md`). It's a plausible future **optional inspector**, in the same slot as floci's web console: pulled on demand, talking to the wire-compatible API like any other client would, never required. It is not being deleted, and it is not the current priority.

Mininet/P4/BMv2 network-level emulation, HTTPS/TLS termination, and a packaged reproducible Linux appliance remain out of scope for the same reasons the old POC.md gave — they just matter even less now that the primary goal is API wire compatibility rather than a network-failure teaching narrative.

## Public-building notes (condensed)

The old POC.md's public-building section was written for the visitor-demo narrative. The underlying habits still apply, just pointed at the new milestones:

> What I tried → what actually happened → the evidence → what I changed or still don't understand.

Worth a post when it's true, not before: the first real `wrangler deploy` succeeding against local Localflare; the first Terraform `apply` provisioning a local Worker; the compat suite going green against a real SDK for the first time. Each of those is a floci-style "point your existing tool at localhost and it just works" moment — the same kind of concrete, verifiable claim the account's prior posts already respond well to. Keep the same discipline as before: show the real artifact (a terminal clip, a diff, a compat-test run), name the one open question, and don't post ahead of the evidence.
