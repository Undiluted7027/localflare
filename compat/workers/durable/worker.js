export class Counter {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const count = (await this.state.storage.get("count") ?? 0) + 1;
    await this.state.storage.put("count", count);
    return new Response(String(count));
  }
}

export default {
  fetch(request, env) {
    const id = env.COUNTER.idFromName("local");
    return env.COUNTER.get(id).fetch(request);
  },
};
