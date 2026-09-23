export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      await env.BUCKET.put("from-worker", await request.text());
      return new Response("stored");
    }
    const object = await env.BUCKET.get("folder/example.txt");
    return new Response(object ? await object.text() : "missing");
  },
};
