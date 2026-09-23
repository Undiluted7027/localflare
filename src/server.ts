import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WorkerStore, InvalidWorkerUpload } from "./workers.js";

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

function reply(response: ServerResponse, status: number, result: unknown, options?: {
  code?: number;
  message?: string;
  resultInfo?: object;
}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    success: status < 400,
    errors: status < 400 ? [] : [{ code: options?.code ?? 1000, message: options?.message ?? "Unknown API endpoint" }],
    messages: [],
    result,
    ...(options?.resultInfo ? { result_info: options.resultInfo } : {}),
  }));
}

async function readBody(request: IncomingMessage) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Uint8Array;
    size += bytes.byteLength;
    if (size > 10 * 1024 * 1024) throw new InvalidWorkerUpload("Request body exceeds 10 MiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readForm(request: IncomingMessage) {
  const body = await readBody(request);
  let contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) {
    // The official SDK sends multipart bytes with an application/javascript header.
    const firstLineEnd = body.indexOf("\r\n");
    const delimiter = body.subarray(0, firstLineEnd).toString("ascii");
    if (firstLineEnd < 0 || !delimiter.startsWith("--") || delimiter.length < 3) {
      throw new InvalidWorkerUpload("Expected multipart Worker upload");
    }
    contentType = `multipart/form-data; boundary=${delimiter.slice(2)}`;
  }
  const formRequest = new Request("http://localflare.invalid", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(body),
  });
  let form: FormData;
  try {
    form = await formRequest.formData();
  } catch {
    throw new InvalidWorkerUpload("Invalid multipart Worker upload");
  }
  if (!form.has("metadata")) {
    const metadata: Record<string, string> = {};
    for (const [key, value] of form) {
      if (!key.startsWith("metadata[")) continue;
      const field = /^metadata\[([a-z_]+)\]$/.exec(key)?.[1];
      if (!field || typeof value !== "string") {
        throw new InvalidWorkerUpload(`Unsupported metadata field: ${key}`);
      }
      metadata[field] = value;
    }
    form.set("metadata", JSON.stringify(metadata));
  }
  for (const file of form.getAll("files[]")) {
    if (file instanceof File) form.set(file.name, file);
  }
  return form;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readBody(request)).toString("utf8")) as unknown;
  } catch {
    throw new InvalidWorkerUpload("Invalid JSON body");
  }
}

function sendScript(response: ServerResponse, content: string) {
  response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
  response.end(content);
}

async function dispatchWorker(request: IncomingMessage, response: ServerResponse, workers: WorkerStore, name: string, path: string) {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const workerRequest = new Request(`http://worker.localflare.internal${path}`, {
    method: request.method,
    headers: request.headers as HeadersInit,
    body: body ? new Uint8Array(body) : undefined,
  });
  const workerResponse = await workers.dispatch(name, workerRequest);
  if (!workerResponse) {
    reply(response, 404, null, { code: 10007, message: "Worker not found" });
    return;
  }
  const headers = new Headers(Object.fromEntries(workerResponse.headers));
  headers.delete("mf-content-encoding");
  response.writeHead(workerResponse.status, Object.fromEntries(headers));
  response.end(Buffer.from(await workerResponse.arrayBuffer()));
}

async function handle(request: IncomingMessage, response: ServerResponse, workers: WorkerStore) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = request.method;

  const localWorker = /^\/__localflare\/workers\/([^/]+)(\/.*)?$/.exec(pathname);
  if (localWorker) {
    await dispatchWorker(request, response, workers, localWorker[1]!, `${localWorker[2] ?? "/"}${url.search}`);
    return;
  }

  if (method === "GET") {
    switch (pathname) {
      case "/client/v4/user/tokens/verify":
        reply(response, 200, token);
        return;
      case "/client/v4/user":
        reply(response, 200, user);
        return;
      case "/client/v4/accounts":
        reply(response, 200, [account], { resultInfo: pageInfo });
        return;
      case "/client/v4/memberships":
        reply(response, 200, [{
          id: "00000000000000000000000000000004",
          account,
          roles: [],
          status: "accepted",
        }], { resultInfo: pageInfo });
        return;
    }
  }

  const accountPath = /^\/client\/v4\/accounts\/([^/]+)\/workers\/(.*)$/.exec(pathname);
  if (!accountPath || accountPath[1] !== account.id) {
    reply(response, 404, null);
    return;
  }
  const route = accountPath[2]!;
  if (method === "GET" && route === "subdomain") {
    reply(response, 200, { subdomain: "localflare" });
    return;
  }
  if (method === "GET" && route === "scripts") {
    reply(response, 200, workers.list());
    return;
  }
  if (method === "GET" && /^workers\/[^/]+$/.test(route)) {
    const worker = workers.get(route.slice("workers/".length));
    if (worker) reply(response, 200, { subdomain: worker.subdomain, previews_base_config: {} });
    else reply(response, 404, null, { code: 10007, message: "Worker not found" });
    return;
  }

  const scriptPath = /^scripts\/([^/]+)(?:\/(.*))?$/.exec(route);
  const servicePath = /^services\/([^/]+)$/.exec(route);
  if (servicePath && method === "GET") {
    const worker = workers.get(servicePath[1]!);
    if (worker) {
      reply(response, 200, {
        id: servicePath[1],
        default_environment: { environment: "production", script: worker.script },
      });
    } else {
      reply(response, 404, null, { code: 10007, message: "Worker not found" });
    }
    return;
  }
  if (!scriptPath) {
    reply(response, 404, null);
    return;
  }

  const name = scriptPath[1]!;
  const suffix = scriptPath[2];
  if (method === "GET" && suffix === "secrets") {
    if (workers.get(name)) reply(response, 200, []);
    else reply(response, 404, null, { code: 10007, message: "Worker not found" });
    return;
  }
  if (method === "GET" && suffix === "deployments") {
    reply(response, 200, { deployments: [] });
    return;
  }
  if (method === "POST" && suffix === "deployments") {
    reply(response, 200, { id: randomUUID() });
    return;
  }
  if (method === "PATCH" && suffix === "script-settings") {
    reply(response, 200, {});
    return;
  }
  if (method === "POST" && suffix === "subdomain") {
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || !("enabled" in body) || typeof body.enabled !== "boolean") {
      reply(response, 400, null, { code: 10021, message: "Invalid subdomain settings" });
      return;
    }
    const settings = {
      enabled: body.enabled,
      previews_enabled: "previews_enabled" in body && typeof body.previews_enabled === "boolean" ? body.previews_enabled : false,
    };
    if (workers.setSubdomain(name, settings)) reply(response, 200, settings);
    else reply(response, 404, null, { code: 10007, message: "Worker not found" });
    return;
  }
  if (method === "GET" && (suffix === undefined || suffix === "content/v2")) {
    const worker = workers.get(name);
    if (worker) sendScript(response, worker.content);
    else reply(response, 404, null, { code: 10007, message: "Worker not found" });
    return;
  }
  if (method === "PUT" && suffix === undefined) {
    const uploaded = await workers.put(name, await readForm(request));
    reply(response, 200, uploaded);
    return;
  }
  if (method === "POST" && suffix === "versions") {
    const uploaded = await workers.put(name, await readForm(request));
    reply(response, 200, {
      id: uploaded.deployment_id,
      resources: { script: { etag: uploaded.tag } },
      startup_time_ms: uploaded.startup_time_ms,
    });
    return;
  }
  if (method === "DELETE" && suffix === undefined) {
    const deleted = await workers.delete(name);
    reply(response, deleted ? 200 : 404, deleted ? {} : null, deleted ? undefined : { code: 10007, message: "Worker not found" });
    return;
  }
  reply(response, 404, null);
}

export function createLocalflareServer() {
  const workers = new WorkerStore();
  const server = createServer((request, response) => {
    void handle(request, response, workers).catch((error: unknown) => {
      if (error instanceof InvalidWorkerUpload) {
        reply(response, 400, null, { code: 10021, message: error.message });
      } else {
        console.error(error);
        reply(response, 500, null, { code: 1000, message: "Internal server error" });
      }
    });
  });
  server.on("close", () => { void workers.dispose().catch(console.error); });
  return server;
}
