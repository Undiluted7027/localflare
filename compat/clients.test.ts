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
      WRANGLER_SEND_METRICS: "false",
    },
    timeout: 30_000,
  });
  const output: unknown = JSON.parse(stdout);
  assert.ok(typeof output === "object" && output !== null && "accounts" in output);
  assert.deepEqual(output.accounts, [account]);
});

test("real Wrangler deploys and redeploys a Worker that runs in workerd", async () => {
  const name = "compat-worker";
  const wrangler = resolve("node_modules/.bin/wrangler");
  const args = [
    "deploy", resolve("compat/workers/hello.js"), "--name", name,
    "--compatibility-date", "2025-07-18", "--no-autoconfig",
  ];
  const env = {
    ...process.env,
    CLOUDFLARE_API_BASE_URL: baseURL,
    CLOUDFLARE_API_TOKEN: "localflare-fake-token",
    CLOUDFLARE_ACCOUNT_ID: account.id,
    WRANGLER_SEND_METRICS: "false",
  };

  const first = await run(wrangler, args, { env, timeout: 30_000 });
  assert.match(first.stdout, /Deployed compat-worker triggers/);
  const second = await run(wrangler, args, { env, timeout: 30_000 });
  assert.match(second.stdout, /Deployed compat-worker triggers/);

  const invocation = await fetch(`${baseURL.replace("/client/v4", "")}/__localflare/workers/${name}/hello`);
  assert.equal(invocation.status, 200);
  assert.equal(await invocation.text(), "Localflare Worker: /hello");

  const client = new Cloudflare({ apiToken: "localflare-fake-token", baseURL });
  const scripts = await client.workers.scripts.list({ account_id: account.id });
  assert.ok(scripts.result.some((script) => script.id === name));
  const content = await client.workers.scripts.get(name, { account_id: account.id });
  assert.match(content, /Localflare Worker/);
  await client.workers.scripts.update(name, {
    account_id: account.id,
    metadata: { main_module: "sdk.js" },
    files: [new File([
      "export default { fetch() { return new Response('updated by SDK') } }",
    ], "sdk.js", { type: "application/javascript+module" })],
  });
  const updated = await fetch(`${baseURL.replace("/client/v4", "")}/__localflare/workers/${name}/hello`);
  assert.equal(await updated.text(), "updated by SDK");
  await client.workers.scripts.delete(name, { account_id: account.id });
  const missing = await fetch(`${baseURL.replace("/client/v4", "")}/__localflare/workers/${name}/hello`);
  assert.equal(missing.status, 404);
});

test("real Wrangler deploys a Durable Object and keeps its state on redeploy", async () => {
  const wrangler = resolve("node_modules/.bin/wrangler");
  const config = resolve("compat/workers/durable/wrangler.jsonc");
  const env = {
    ...process.env,
    CLOUDFLARE_API_BASE_URL: baseURL,
    CLOUDFLARE_API_TOKEN: "localflare-fake-token",
    CLOUDFLARE_ACCOUNT_ID: account.id,
    WRANGLER_SEND_METRICS: "false",
  };
  const deploy = () => run(wrangler, ["deploy", "--config", config, "--no-autoconfig"], {
    env, timeout: 30_000,
  });
  const invokeURL = `${baseURL.replace("/client/v4", "")}/__localflare/workers/durable-counter/`;

  assert.match((await deploy()).stdout, /Deployed durable-counter triggers/);
  assert.equal(await (await fetch(invokeURL)).text(), "1");
  assert.equal(await (await fetch(invokeURL)).text(), "2");
  assert.match((await deploy()).stdout, /Deployed durable-counter triggers/);
  assert.equal(await (await fetch(invokeURL)).text(), "3");
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
