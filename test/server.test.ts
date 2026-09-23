import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { account, createLocalflareServer } from "../src/server.js";

const server = createLocalflareServer();
let baseURL: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("local identity works with or without a fake bearer token", async () => {
  const withoutToken = await fetch(`${baseURL}/accounts`);
  const withToken = await fetch(`${baseURL}/accounts`, {
    headers: { authorization: "Bearer anything-local" },
  });

  assert.equal(withoutToken.status, 200);
  assert.equal(withToken.status, 200);
  const anonymousBody = await withoutToken.json();
  assert.deepEqual(await withToken.json(), anonymousBody);
  assert.deepEqual(anonymousBody, {
    success: true,
    errors: [],
    messages: [],
    result: [account],
    result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 },
  });
});

test("an invalid replacement leaves the deployed Worker running", async () => {
  const scriptURL = `${baseURL}/accounts/${account.id}/workers/scripts/atomic`;
  const invokeURL = baseURL.replace("/client/v4", "/__localflare/workers/atomic/");
  const upload = (source: string) => {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: "worker.js" }));
    form.set("worker.js", new File([source], "worker.js", { type: "application/javascript+module" }));
    return fetch(scriptURL, { method: "PUT", body: form });
  };

  assert.equal((await upload("export default { fetch() { return new Response('working') } }")).status, 200);
  assert.equal(await (await fetch(invokeURL)).text(), "working");
  assert.equal((await upload("export default { fetch( { broken")).status, 400);
  assert.equal(await (await fetch(invokeURL)).text(), "working");
});

test("service worker syntax runs through Miniflare", async () => {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ body_part: "worker.js" }));
  form.set("worker.js", new File([
    "addEventListener('fetch', event => event.respondWith(new Response('classic worker')))",
  ], "worker.js", { type: "application/javascript" }));
  const uploaded = await fetch(`${baseURL}/accounts/${account.id}/workers/scripts/classic`, {
    method: "PUT", body: form,
  });
  assert.equal(uploaded.status, 200);
  const invocation = await fetch(baseURL.replace("/client/v4", "/__localflare/workers/classic/"));
  assert.equal(await invocation.text(), "classic worker");
});
