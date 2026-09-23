import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const account = {
  id: "00000000000000000000000000000001",
  name: "Localflare",
  type: "standard",
} as const;

const token = {
  id: "00000000000000000000000000000002",
  status: "active",
} as const;

const user = {
  id: "00000000000000000000000000000003",
  email: "local@localflare.test",
} as const;

const pageInfo = {
  page: 1,
  per_page: 20,
  count: 1,
  total_count: 1,
  total_pages: 1,
} as const;

function reply(response: ServerResponse, status: number, result: unknown, resultInfo?: object) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    success: status < 400,
    errors: status < 400 ? [] : [{ code: 1000, message: "Unknown API endpoint" }],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  }));
}

function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    reply(response, 404, null);
    return;
  }

  switch (url.pathname) {
    case "/client/v4/user/tokens/verify":
      reply(response, 200, token);
      break;
    case "/client/v4/user":
      reply(response, 200, user);
      break;
    case "/client/v4/accounts":
      reply(response, 200, [account], pageInfo);
      break;
    case "/client/v4/memberships":
      reply(response, 200, [{
        id: "00000000000000000000000000000004",
        account,
        roles: [],
        status: "accepted",
      }], pageInfo);
      break;
    default:
      reply(response, 404, null);
  }
}

export function createLocalflareServer() {
  return createServer(handle);
}
