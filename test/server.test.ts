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

test("KV namespaces reject duplicate titles and keep binary values distinct", async () => {
  const namespacesURL = `${baseURL}/accounts/${account.id}/storage/kv/namespaces`;
  const create = () => fetch(namespacesURL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "unique-kv" }),
  });
  const created = await create();
  assert.equal(created.status, 200);
  const id = (await created.json() as { result: { id: string } }).result.id;
  assert.equal((await create()).status, 400);

  const valueURL = `${namespacesURL}/${id}/values/binary%2Fkey`;
  const bytes = Uint8Array.from([0, 255, 127, 13]);
  assert.equal((await fetch(valueURL, { method: "PUT", body: bytes })).status, 200);
  for (let index = 0; index < 10; index++) {
    assert.equal((await fetch(`${namespacesURL}/${id}/values/key-${index}`, {
      method: "PUT", body: String(index),
    })).status, 200);
  }
  assert.deepEqual(new Uint8Array(await (await fetch(valueURL)).arrayBuffer()), bytes);
  assert.equal((await fetch(`${namespacesURL}/${id}/values/missing`)).status, 404);
  assert.equal((await fetch(`${namespacesURL}/${id}/values/short`, {
    method: "PUT", body: "short", headers: { "content-type": "text/plain" },
  })).status, 200);
  assert.equal((await fetch(`${namespacesURL}/${id}/values/short?expiration_ttl=1`, {
    method: "PUT", body: "short",
  })).status, 400);
  const firstKeys = await (await fetch(`${namespacesURL}/${id}/keys?limit=10`)).json() as {
    result: Array<{ name: string }>;
    result_info: { cursor: string };
  };
  assert.equal(firstKeys.result.length, 10);
  assert.ok(firstKeys.result_info.cursor);
  const nextKeys = await (await fetch(`${namespacesURL}/${id}/keys?limit=10&cursor=${encodeURIComponent(firstKeys.result_info.cursor)}`)).json() as {
    result: Array<{ name: string }>;
  };
  assert.equal(nextKeys.result.length, 2);
  assert.ok(nextKeys.result.every((key) => !firstKeys.result.some((first) => first.name === key.name)));

  const page = await (await fetch(`${namespacesURL}?page=2&per_page=1`)).json() as {
    result: Array<{ id: string }>;
    result_info: { page: number; per_page: number; total_count: number };
  };
  assert.equal(page.result_info.page, 2);
  assert.equal(page.result_info.per_page, 1);
  assert.equal(page.result_info.total_count, 1);
  assert.deepEqual(page.result, []);
  assert.equal((await fetch(`${namespacesURL}/${id}`, { method: "DELETE" })).status, 200);
});
