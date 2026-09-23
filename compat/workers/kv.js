export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      await env.KV.put("shared/key", "written by Worker");
    }
    return new Response(await env.KV.get("shared/key") ?? "missing");
  },
};
