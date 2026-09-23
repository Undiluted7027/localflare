export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      await env.DB.prepare("INSERT INTO notes (body) VALUES (?)").bind("from Worker").run();
    }
    const notes = await env.DB.prepare("SELECT body FROM notes ORDER BY id").all();
    return Response.json(notes.results);
  },
};
