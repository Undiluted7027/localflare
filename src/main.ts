import { createLocalflareServer } from "./server.js";

const port = Number(process.env.PORT ?? "8788");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer from 0 to 65535");
}

const server = createLocalflareServer();
server.listen(port, "127.0.0.1", () => {
  console.log(`Localflare listening on http://127.0.0.1:${port}/client/v4`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close());
}
