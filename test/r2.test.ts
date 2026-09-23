import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { account, createLocalflareServer } from "../src/server.js";

const server = createLocalflareServer();
let origin: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("R2 preserves binary objects and rejects deletion of a nonempty bucket", async () => {
  const bucket = "r2-edge-bucket";
  const bucketURL = `${origin}/${bucket}`;
  const objectURL = `${bucketURL}/nested%2Fbinary`;
  const managementURL = `${origin}/client/v4/accounts/${account.id}/r2/buckets/${bucket}`;
  assert.equal((await fetch(bucketURL, { method: "PUT" })).status, 200);
  const bytes = Uint8Array.from([0, 255, 128, 13]);
  const written = await fetch(objectURL, { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" } });
  assert.equal(written.status, 200);
  assert.match(written.headers.get("etag") ?? "", /^"[a-f0-9]{32}"$/);
  const read = await fetch(objectURL);
  assert.equal(read.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await fetch(bucketURL, { method: "DELETE" })).status, 409);
  assert.equal((await fetch(managementURL, { method: "DELETE" })).status, 409);
  assert.equal((await fetch(objectURL, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(objectURL)).status, 404);
  assert.equal((await fetch(bucketURL, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(bucketURL, { method: "PUT" })).status, 200);
  assert.equal((await fetch(objectURL)).status, 404);
});

test("R2 rejects invalid bucket names and reports missing buckets", async () => {
  const invalid = await fetch(`${origin}/NotValid`, { method: "PUT" });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /InvalidBucketName/);
  const missing = await fetch(`${origin}/absent-bucket/key`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /NoSuchBucket/);
});
