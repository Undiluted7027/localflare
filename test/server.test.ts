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
