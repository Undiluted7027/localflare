# Localflare — the floci of Cloudflare

The idea is to make a free, headless, wire-compatible local Cloudflare emulator, in the spirit of [floci](https://github.com/floci-io/floci) for AWS.
Point `wrangler`, the Cloudflare Terraform provider, and the official Cloudflare SDKs at a local endpoint and have them work unmodified — no dashboard, no account, no auth token.
Workers run on the real runtime (workerd via Miniflare); KV, D1, R2, Durable Objects, Queues, Rulesets, Zones, and DNS get built out service by service behind Cloudflare's actual `client/v4` wire shapes.
See `POC.md` for the full plan and checkpoints.

## Important

Your code must be such that it is readable, reviewable and can be maintained by other devs in the future. If the product itself is working but I can't explain how or even I can't understand what you did, that implementation and work will be moot. Always focus on implementability, maintainability, and simplicity.

I would rather see six tests that specifically cover the difficult cases and business logic than forty tests that only repeat happy-path checks and are coverage maxxers.

## Coding preferences - general

- Keep things simple. Channel "yagni" energy unless told otherwise.
- Typesafety is useful, take advantage of it.
- Be pragmatic about eslint ignores. Whenever using eslint ignore declaratives,
  explicitly add comment stating the justification. Not all eslint rules will
  accurately describe the problem/convention. This is especially true for security
  related rules that may require deeper invetigation and analysis before deciding to
  use eslint ignores.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Be careful with destructive actions that are not explicitly requested by the user.
- Tests are good! Endless smoke tests, "regression tests" for feature deletions, etc,
  much less good. Tests should be focused, not slop.
- Comments are a great way to clarify functionality and how code is used. Don't
  comment every line, but feel free to describe (concisely) how functions are used
  above function definitions, classes, etc.
- Keep comments up to date! When making changes, it's important to keep things in
  sync.


## Coding preferences (Typescript focused)

- It is ok if you need to change config files. But do not go on making those config related changes. You propose first. The changes can be as bold as you like but only if they meaningfully benefit our work.
- `any` is the enemy. Inferred types are our friend. Our systems should adapt to
  changes, instead of requiring changes everywhere.
- If your TS code looks like a Python dev wrote it, it is bad TS code.
- Avoid one-line functions that are just casting wrappers.
- Write TypeScript in ways that Matt Pocock and Theo Browne would be proud of.


## Build Preferences

- Always build in terms of features. Never rely solely on backend, frontend, db, etc.
- Build in increments or slices.
- Test driven development is nice.

