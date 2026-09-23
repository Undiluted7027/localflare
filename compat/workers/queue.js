export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      await env.QUEUE.send(await request.text());
      return new Response("queued");
    }
    return new Response((await env.STATE.get("received")) ?? "pending");
  },

  async queue(batch, env) {
    await env.STATE.put("received", batch.messages.map((message) => message.body).join(","));
  },
};
