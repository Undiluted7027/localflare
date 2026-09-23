import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { account, createLocalflareServer } from "../src/server.js";

const server = createLocalflareServer();
let queuesURL: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  queuesURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4/accounts/${account.id}/queues`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("queue names are unique and consumer validation leaves state unchanged", async () => {
  const created = await post(queuesURL, { queue_name: "orders" });
  assert.equal(created.status, 200);
  const queue = (await created.json() as { result: { queue_id: string } }).result;
  assert.equal((await post(queuesURL, { queue_name: "orders" })).status, 409);
  assert.equal((await post(queuesURL, { queue_name: "bad_name" })).status, 400);
  const consumersURL = `${queuesURL}/${queue.queue_id}/consumers`;
  assert.equal((await post(consumersURL, {
    type: "worker", script_name: "consumer", settings: { batch_size: -1 },
  })).status, 400);
  assert.deepEqual((await (await fetch(consumersURL)).json() as { result: unknown[] }).result, []);

  const consumerResponse = await post(consumersURL, {
    type: "worker", script_name: "consumer", settings: { batch_size: 2 },
  });
  assert.equal(consumerResponse.status, 200);
  const consumer = (await consumerResponse.json() as { result: { consumer_id: string } }).result;
  assert.equal((await post(consumersURL, { type: "worker", script_name: "consumer" })).status, 400);
  assert.equal((await fetch(`${queuesURL}/${queue.queue_id}`, { method: "DELETE" })).status, 409);
  assert.equal((await fetch(`${consumersURL}/${consumer.consumer_id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${queuesURL}/${queue.queue_id}`, { method: "DELETE" })).status, 200);
});

test("queue list filters by exact name and rejects bad pagination", async () => {
  assert.equal((await post(queuesURL, { queue_name: "jobs" })).status, 200);
  assert.equal((await post(queuesURL, { queue_name: "jobs-old" })).status, 200);
  const page = await fetch(`${queuesURL}?name=jobs`);
  assert.deepEqual((await page.json() as { result: Array<{ queue_name: string }> }).result
    .map((queue) => queue.queue_name), ["jobs"]);
  assert.equal((await fetch(`${queuesURL}?page=0`)).status, 400);
});

test("a deployed Queue producer keeps its queue from being deleted", async () => {
  const created = await post(queuesURL, { queue_name: "bound-queue" });
  const queue = (await created.json() as { result: { queue_id: string } }).result;
  const form = new FormData();
  form.set("metadata", JSON.stringify({
    main_module: "worker.js", bindings: [{ type: "queue", name: "QUEUE", queue_name: "bound-queue" }],
  }));
  form.set("worker.js", new File([
    "export default { fetch() { return new Response('ready') } }",
  ], "worker.js", { type: "application/javascript+module" }));
  const workerURL = queuesURL.replace(/\/queues$/, "/workers/scripts/queue-producer");
  assert.equal((await fetch(workerURL, { method: "PUT", body: form })).status, 200);
  assert.equal((await fetch(`${queuesURL}/${queue.queue_id}`, { method: "DELETE" })).status, 409);
  assert.equal((await fetch(workerURL, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${queuesURL}/${queue.queue_id}`, { method: "DELETE" })).status, 200);
});
