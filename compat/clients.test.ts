import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import Cloudflare from "cloudflare";
import { account, createLocalflareServer } from "../src/server.js";

const run = promisify(execFile);
const server = createLocalflareServer();
let baseURL: string;

before(async () => {
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${address.port}/client/v4`;
});

after(async () => {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error ? reject(error) : resolveClosed());
  });
});

test("real Wrangler whoami uses the local API and prints its account", async () => {
  const wrangler = resolve("node_modules/.bin/wrangler");
  const { stdout } = await run(wrangler, ["whoami", "--json"], {
    env: {
      ...process.env,
      CLOUDFLARE_API_BASE_URL: baseURL,
      CLOUDFLARE_API_TOKEN: "localflare-fake-token",
      CLOUDFLARE_SEND_METRICS: "false",
    },
    timeout: 30_000,
  });
  const output: unknown = JSON.parse(stdout);
  assert.ok(typeof output === "object" && output !== null && "accounts" in output);
  assert.deepEqual(output.accounts, [account]);
});

test("official TypeScript SDK verifies a fake token and lists the local account", async () => {
  const client = new Cloudflare({ apiToken: "localflare-fake-token", baseURL });
  const verification = await client.user.tokens.verify();
  assert.equal(verification?.status, "active");

  const page = await client.accounts.list();
  assert.equal(page.result[0]?.id, account.id);
  assert.equal(page.result[0]?.name, account.name);
});

test("real Terraform provider reads accounts through base_url", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localflare-terraform-"));
  try {
    const fixture = await readFile(new URL("./terraform/main.tf", import.meta.url), "utf8");
    await writeFile(join(directory, "main.tf"), fixture.replaceAll("LOCALFLARE_BASE_URL", baseURL));
    const env = { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" };
    await run("terraform", ["init", "-no-color"], { cwd: directory, env, timeout: 180_000 });
    await run("terraform", ["apply", "-auto-approve", "-no-color"], { cwd: directory, env, timeout: 60_000 });
    const { stdout } = await run("terraform", ["output", "-raw", "account_id"], {
      cwd: directory, env, timeout: 30_000,
    });
    assert.equal(stdout.trim(), account.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
