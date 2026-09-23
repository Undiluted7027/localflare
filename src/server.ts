import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WorkerStore, InvalidWorkerUpload } from "./workers.js";
import { KVStore } from "./kv.js";
import { D1Store, type D1Query, type SqlParam } from "./d1.js";
import { ZoneStore, normalizeZoneName, type SettingId, type ZoneType } from "./zones.js";
import { RulesetStore, InvalidRuleset } from "./rulesets.js";
import { DNSStore, InvalidDNSRecord } from "./dns.js";
import { acknowledgePurge, InvalidCachePurge } from "./cache.js";
import { R2Store, validBucketName } from "./r2.js";
import { handleS3 } from "./s3.js";

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

function titleFromBody(body: unknown) {
  if (typeof body !== "object" || body === null || !("title" in body) ||
      typeof body.title !== "string" || body.title.length === 0 || body.title.length > 512) {
    throw new InvalidWorkerUpload("Namespace title must be 1–512 characters");
  }
  return body.title;
}

async function handleKV(request: IncomingMessage, response: ServerResponse, kv: KVStore, route: string, url: URL) {
  const method = request.method;
  if (route === "namespaces") {
    if (method === "POST") {
      const title = titleFromBody(await readJson(request));
      const created = await kv.create(title);
      if (!created) {
        reply(response, 400, null, { code: 10021, message: "Namespace title already exists" });
        return;
      }
      reply(response, 200, created);
      return;
    }
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("per_page") ?? 20);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 1000) {
        throw new InvalidWorkerUpload("Invalid namespace pagination");
      }
      const namespaces = kv.list().sort((a, b) => a.title.localeCompare(b.title));
      const result = namespaces.slice((page - 1) * perPage, page * perPage);
      reply(response, 200, result, { resultInfo: {
        page, per_page: perPage, count: result.length,
        total_count: namespaces.length, total_pages: Math.ceil(namespaces.length / perPage),
      } });
      return;
    }
  }

  const match = /^namespaces\/([^/]+)(?:\/(.*))?$/.exec(route);
  if (!match) {
    reply(response, 404, null);
    return;
  }
  const id = match[1]!;
  const suffix = match[2];
  const namespace = kv.get(id);
  if (!namespace) {
    reply(response, 404, null, { code: 10013, message: "KV namespace not found" });
    return;
  }
  if (suffix === undefined) {
    if (method === "GET") reply(response, 200, namespace);
    else if (method === "PUT") {
      const title = titleFromBody(await readJson(request));
      if (kv.hasTitle(title, id)) reply(response, 400, null, { code: 10021, message: "Namespace title already exists" });
      else reply(response, 200, kv.rename(id, title));
    } else if (method === "DELETE") {
      await kv.delete(id);
      reply(response, 200, {});
    } else reply(response, 404, null);
    return;
  }

  const binding = await kv.binding(id);
  if (!binding) throw new Error("KV namespace has no Miniflare binding");
  if (suffix === "keys" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    if (!Number.isInteger(limit) || limit < 10 || limit > 1000) throw new InvalidWorkerUpload("Invalid key list limit");
    const listed = await binding.list({
      prefix: url.searchParams.get("prefix") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
    });
    reply(response, 200, listed.keys, { resultInfo: { count: listed.keys.length, cursor: listed.cursor ?? "" } });
    return;
  }
  if (!suffix.startsWith("values/")) {
    reply(response, 404, null);
    return;
  }
  let key: string;
  try {
    key = decodeURIComponent(suffix.slice("values/".length));
  } catch {
    throw new InvalidWorkerUpload("Invalid key encoding");
  }
  if (!key || Buffer.byteLength(key) > 512) throw new InvalidWorkerUpload("KV key must be 1–512 bytes");
  if (method === "PUT") {
    const contentType = request.headers["content-type"] ?? "";
    let value: Uint8Array = await readBody(request);
    let metadata: unknown;
    if (contentType.startsWith("multipart/form-data")) {
      const formRequest = new Request("http://localflare.invalid", {
        method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(value),
      });
      const form = await formRequest.formData();
      const field = form.get("value");
      if (field === null) throw new InvalidWorkerUpload("Missing KV value");
      value = typeof field === "string" ? Buffer.from(field) : new Uint8Array(await field.arrayBuffer());
      const rawMetadata = form.get("metadata");
      if (rawMetadata !== null) {
        if (typeof rawMetadata !== "string") throw new InvalidWorkerUpload("Invalid KV metadata");
        try { metadata = JSON.parse(rawMetadata) as unknown; }
        catch { throw new InvalidWorkerUpload("Invalid KV metadata JSON"); }
      } else {
        const fields = [...form].filter(([name]) => name.startsWith("metadata["));
        if (fields.length > 0) {
          const object: Record<string, string> = {};
          for (const [name, entry] of fields) {
            const fieldName = /^metadata\[([^\]]+)\]$/.exec(name)?.[1];
            if (!fieldName || typeof entry !== "string") throw new InvalidWorkerUpload("Invalid KV metadata field");
            object[fieldName] = entry;
          }
          metadata = object;
        }
      }
    }
    const expiration = url.searchParams.get("expiration");
    const expirationTtl = url.searchParams.get("expiration_ttl");
    if (expiration !== null && (!Number.isInteger(Number(expiration)) || Number(expiration) <= 0)) {
      throw new InvalidWorkerUpload("Invalid expiration");
    }
    if (expirationTtl !== null && (!Number.isInteger(Number(expirationTtl)) || Number(expirationTtl) < 60)) {
      throw new InvalidWorkerUpload("expiration_ttl must be at least 60 seconds");
    }
    await binding.put(key, new Uint8Array(value).buffer, {
      expiration: expiration === null ? undefined : Number(expiration),
      expirationTtl: expirationTtl === null ? undefined : Number(expirationTtl),
      metadata,
    });
    reply(response, 200, null);
    return;
  }
  if (method === "GET") {
    const value = await binding.get(key, "arrayBuffer");
    if (value === null) {
      reply(response, 404, null, { code: 10009, message: "KV key not found" });
    } else {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(value));
    }
    return;
  }
  if (method === "DELETE") {
    await binding.delete(key);
    reply(response, 200, null);
    return;
  }
  reply(response, 404, null);
}

function parseD1Query(value: unknown): D1Query {
  if (typeof value !== "object" || value === null || !("sql" in value) ||
      typeof value.sql !== "string" || value.sql.trim().length === 0) {
    throw new InvalidWorkerUpload("D1 query needs nonempty sql");
  }
  let params: SqlParam[] | undefined;
  if ("params" in value && value.params !== undefined) {
    if (!Array.isArray(value.params) || !value.params.every((param: unknown) =>
      param === null || typeof param === "string" || typeof param === "number" || typeof param === "boolean")) {
      throw new InvalidWorkerUpload("D1 params must be scalar values");
    }
    params = value.params as SqlParam[];
  }
  return { sql: value.sql, params };
}

function parseD1Queries(body: unknown) {
  if (typeof body !== "object" || body === null) throw new InvalidWorkerUpload("Invalid D1 query body");
  if ("batch" in body) {
    if (!Array.isArray(body.batch) || body.batch.length === 0) throw new InvalidWorkerUpload("D1 batch cannot be empty");
    return body.batch.map(parseD1Query);
  }
  return [parseD1Query(body)];
}

async function handleD1(request: IncomingMessage, response: ServerResponse, d1: D1Store, route: string, url: URL) {
  const method = request.method;
  if (route === "database") {
    if (method === "POST") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || !("name" in body) ||
          typeof body.name !== "string" || body.name.length === 0) {
        throw new InvalidWorkerUpload("D1 database needs a name");
      }
      const created = await d1.create(body.name);
      if (created) reply(response, 200, created);
      else reply(response, 400, null, { code: 7502, message: "A database with that name already exists" });
      return;
    }
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("per_page") ?? 10);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 1000) {
        throw new InvalidWorkerUpload("Invalid D1 pagination");
      }
      const databases = d1.list()
        .filter((database) => !url.searchParams.has("name") || database.name === url.searchParams.get("name"))
        .sort((a, b) => a.name.localeCompare(b.name));
      const result = databases.slice((page - 1) * perPage, page * perPage);
      reply(response, 200, result, { resultInfo: {
        page, per_page: perPage, count: result.length,
        total_count: databases.length, total_pages: Math.ceil(databases.length / perPage),
      } });
      return;
    }
  }

  const match = /^database\/([^/]+)(?:\/(.*))?$/.exec(route);
  if (!match) {
    reply(response, 404, null);
    return;
  }
  const idOrName = decodeURIComponent(match[1]!);
  const database = d1.get(idOrName);
  if (!database) {
    reply(response, 404, null, { code: 7404, message: "D1 database not found" });
    return;
  }
  const suffix = match[2];
  if (suffix === undefined) {
    if (method === "GET") reply(response, 200, database);
    else if (method === "DELETE") {
      await d1.delete(database.uuid);
      reply(response, 200, null);
    } else if (method === "PUT" || method === "PATCH") {
      const body = await readJson(request);
      const replication = typeof body === "object" && body !== null && "read_replication" in body
        ? body.read_replication : undefined;
      const mode = typeof replication === "object" && replication !== null && "mode" in replication
        ? replication.mode : undefined;
      if (mode !== "auto" && mode !== "disabled") {
        throw new InvalidWorkerUpload("D1 read_replication.mode must be auto or disabled");
      }
      reply(response, 200, d1.update(database.uuid, mode));
    } else reply(response, 404, null);
    return;
  }
  if (suffix === "query" && method === "POST") {
    const queries = parseD1Queries(await readJson(request));
    try {
      reply(response, 200, await d1.query(database.uuid, queries));
    } catch (error) {
      reply(response, 400, null, { code: 7500, message: error instanceof Error ? error.message : "D1 query failed" });
    }
    return;
  }
  reply(response, 404, null);
}

function zoneType(value: unknown): value is ZoneType {
  return value === "full" || value === "partial" || value === "secondary" || value === "internal";
}

async function handleZones(request: IncomingMessage, response: ServerResponse, zones: ZoneStore, url: URL) {
  const method = request.method;
  const { pathname } = url;
  if (pathname === "/client/v4/zones") {
    if (method === "POST") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || !("account" in body) ||
          typeof body.account !== "object" || body.account === null ||
          !("name" in body) || typeof body.name !== "string") {
        throw new InvalidWorkerUpload("Zone needs account and name");
      }
      if ("id" in body.account && body.account.id !== account.id) {
        reply(response, 400, null, { code: 10021, message: "Unknown account" });
        return;
      }
      const name = normalizeZoneName(body.name);
      const type = "type" in body ? body.type : "full";
      if (!name || !zoneType(type)) throw new InvalidWorkerUpload("Invalid zone name or type");
      const created = zones.create(name, type);
      if (created) reply(response, 200, created);
      else reply(response, 400, null, { code: 1061, message: "Zone already exists" });
      return;
    }
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("per_page") ?? 20);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 5 || perPage > 50) {
        throw new InvalidWorkerUpload("Invalid zone pagination");
      }
      const accountId = url.searchParams.get("account[id]") ?? url.searchParams.get("account.id");
      let result = zones.list().filter((zone) =>
        (!accountId || zone.account.id === accountId) &&
        (!url.searchParams.has("name") || zone.name === url.searchParams.get("name")) &&
        (!url.searchParams.has("status") || zone.status === url.searchParams.get("status")) &&
        (url.searchParams.has("type")
          ? url.searchParams.get("type")?.split(",").includes(zone.type)
          : zone.type !== "internal"));
      result.sort((a, b) => a.name.localeCompare(b.name));
      if (url.searchParams.get("direction") === "desc") result.reverse();
      const total = result.length;
      result = result.slice((page - 1) * perPage, page * perPage);
      reply(response, 200, result, { resultInfo: {
        page, per_page: perPage, count: result.length,
        total_count: total, total_pages: Math.ceil(total / perPage),
      } });
      return;
    }
  }

  const match = /^\/client\/v4\/zones\/([^/]+)(?:\/settings(?:\/([^/]+))?)?$/.exec(pathname);
  if (!match) {
    reply(response, 404, null);
    return;
  }
  const id = match[1]!;
  const zone = zones.get(id);
  if (!zone) {
    reply(response, 404, null, { code: 9109, message: "Zone not found" });
    return;
  }
  const settingId = match[2];
  const isSettings = pathname.includes("/settings");
  if (!isSettings) {
    if (method === "GET") reply(response, 200, zone);
    else if (method === "DELETE") {
      zones.delete(id);
      reply(response, 200, { id });
    } else if (method === "PATCH") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new InvalidWorkerUpload("Invalid zone edit");
      }
      const keys = Object.keys(body);
      if (keys.length === 1 && "paused" in body && typeof body.paused === "boolean") {
        reply(response, 200, zones.edit(id, { paused: body.paused }));
      } else if (keys.length === 1 && "type" in body && zoneType(body.type)) {
        reply(response, 200, zones.edit(id, { type: body.type }));
      } else throw new InvalidWorkerUpload("Zone edit needs one valid property");
    } else reply(response, 404, null);
    return;
  }
  if (settingId === undefined) {
    if (method === "GET") reply(response, 200, zones.listSettings(id));
    else if (method === "PATCH") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items) ||
          body.items.length === 0) {
        throw new InvalidWorkerUpload("Invalid zone settings items");
      }
      const changes: Array<{ id: SettingId; value: string }> = [];
      const items: unknown[] = body.items;
      for (const item of items) {
        if (typeof item !== "object" || item === null || !("id" in item) || !("value" in item) ||
            typeof item.id !== "string" || typeof item.value !== "string" ||
            !zones.acceptsSetting(item.id, item.value)) {
          throw new InvalidWorkerUpload("Invalid zone settings items");
        }
        changes.push({ id: item.id, value: item.value });
      }
      reply(response, 200, zones.editSettings(id, changes));
    } else reply(response, 404, null);
    return;
  }
  if (!zones.getSetting(id, settingId)) {
    reply(response, 404, null, { code: 10021, message: "Zone setting not found" });
    return;
  }
  if (method === "GET") reply(response, 200, zones.getSetting(id, settingId));
  else if (method === "PATCH") {
    const body = await readJson(request);
    const value = typeof body === "object" && body !== null && "value" in body ? body.value : undefined;
    if (typeof value !== "string" || !zones.acceptsSetting(settingId, value)) {
      throw new InvalidWorkerUpload("Invalid zone setting value");
    }
    reply(response, 200, zones.editSettings(id, [{ id: settingId, value }])?.[0]);
  } else reply(response, 404, null);
}

async function handleDNS(request: IncomingMessage, response: ServerResponse, dns: DNSStore,
  zoneId: string, zoneName: string, recordId: string | undefined, url: URL) {
  const method = request.method;
  if (!recordId) {
    if (method === "POST") {
      reply(response, 200, dns.create(zoneId, zoneName, await readJson(request)));
      return;
    }
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("per_page") ?? 100);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 5000) {
        throw new InvalidDNSRecord("Invalid DNS pagination");
      }
      const name = url.searchParams.get("name.exact") ?? url.searchParams.get("name[exact]") ?? url.searchParams.get("name");
      const content = url.searchParams.get("content.exact") ?? url.searchParams.get("content[exact]") ?? url.searchParams.get("content");
      let records = dns.list(zoneId).filter((record) =>
        (!name || record.name === name.toLowerCase()) &&
        (!content || record.content === content) &&
        (!url.searchParams.has("type") || record.type === url.searchParams.get("type")) &&
        (!url.searchParams.has("proxied") || String(record.proxied) === url.searchParams.get("proxied")));
      const order = url.searchParams.get("order") ?? "name";
      if (!(["type", "name", "content", "ttl", "proxied"] as string[]).includes(order)) {
        throw new InvalidDNSRecord("Invalid DNS sort order");
      }
      records.sort((a, b) => String(a[order as keyof typeof a]).localeCompare(String(b[order as keyof typeof b])));
      if (url.searchParams.get("direction") === "desc") records.reverse();
      const total = records.length;
      records = records.slice((page - 1) * perPage, page * perPage);
      reply(response, 200, records, { resultInfo: {
        page, per_page: perPage, count: records.length, total_count: total,
        total_pages: Math.ceil(total / perPage),
      } });
      return;
    }
    reply(response, 404, null);
    return;
  }
  const existing = dns.get(zoneId, recordId);
  if (!existing) {
    reply(response, 404, null, { code: 81044, message: "DNS record not found" });
    return;
  }
  if (method === "GET") reply(response, 200, existing);
  else if (method === "PUT" || method === "PATCH") {
    reply(response, 200, dns.update(zoneId, zoneName, recordId, await readJson(request), method === "PUT"));
  } else if (method === "DELETE") {
    dns.delete(zoneId, recordId);
    reply(response, 200, { id: recordId });
  } else reply(response, 404, null);
}

async function handleR2(request: IncomingMessage, response: ServerResponse, r2: R2Store, route: string, url: URL) {
  const method = request.method;
  if (route === "buckets") {
    if (method === "POST") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || !("name" in body) || typeof body.name !== "string" ||
          !validBucketName(body.name)) {
        throw new InvalidWorkerUpload("Invalid R2 bucket name");
      }
      if (r2.has(body.name)) {
        reply(response, 409, null, { code: 10073, message: "R2 bucket already exists" });
        return;
      }
      if (("locationHint" in body && body.locationHint !== undefined) ||
          ("storageClass" in body && body.storageClass !== undefined && body.storageClass !== "Standard")) {
        throw new InvalidWorkerUpload("R2 location hints and nonstandard storage classes are not supported");
      }
      reply(response, 200, await r2.create(body.name));
      return;
    }
    if (method === "GET") {
      const perPage = Number(url.searchParams.get("per_page") ?? 100);
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 1000) {
        throw new InvalidWorkerUpload("Invalid R2 pagination");
      }
      let buckets = r2.list().filter((bucket) =>
        !url.searchParams.has("name_contains") || bucket.name.includes(url.searchParams.get("name_contains")!));
      if (url.searchParams.get("direction") === "desc") buckets.reverse();
      const after = url.searchParams.get("cursor") ?? url.searchParams.get("start_after");
      if (after) buckets = buckets.filter((bucket) =>
        url.searchParams.get("direction") === "desc" ? bucket.name < after : bucket.name > after);
      const result = buckets.slice(0, perPage);
      reply(response, 200, { buckets: result }, buckets.length > perPage ? {
        resultInfo: { cursor: result.at(-1)?.name, per_page: perPage },
      } : undefined);
      return;
    }
  }
  const bucketName = /^buckets\/([^/]+)$/.exec(route)?.[1];
  if (!bucketName) { reply(response, 404, null); return; }
  const bucket = r2.get(bucketName);
  if (!bucket) { reply(response, 404, null, { code: 10006, message: "R2 bucket not found" }); return; }
  if (method === "GET") reply(response, 200, bucket);
  else if (method === "DELETE") {
    const result = await r2.delete(bucketName);
    if (result === "not-empty") reply(response, 409, null, { code: 10008, message: "R2 bucket is not empty" });
    else reply(response, 200, {});
  } else reply(response, 404, null);
}

function sendScript(response: ServerResponse, content: string) {
  response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
  response.end(content);
}

async function dispatchWorker(request: IncomingMessage, response: ServerResponse, workers: WorkerStore,
  zones: ZoneStore, rulesets: RulesetStore, name: string, path: string) {
  const hostname = request.headers.host?.split(":")[0]?.toLowerCase();
  const zone = hostname ? zones.list()
    .filter((item) => hostname === item.name || hostname.endsWith(`.${item.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0] : undefined;
  const requested = new URL(path, "http://worker.localflare.internal");
  const evaluation = zone && rulesets.evaluate(zone.id, zone.name, hostname!, request.method ?? "GET", requested.pathname, requested.search.slice(1));
  if (evaluation?.kind === "block") {
    response.writeHead(evaluation.status, { "content-type": evaluation.contentType });
    response.end(evaluation.body);
    return;
  }
  if (evaluation?.kind === "redirect") {
    response.writeHead(evaluation.status, { location: evaluation.location });
    response.end();
    return;
  }
  const effectivePath = evaluation?.kind === "pass" ? `${evaluation.path}${requested.search}` : path;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const workerRequest = new Request(`http://worker.localflare.internal${effectivePath}`, {
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

async function handle(request: IncomingMessage, response: ServerResponse, workers: WorkerStore, kv: KVStore,
  d1: D1Store, zones: ZoneStore, rulesets: RulesetStore, dns: DNSStore, r2: R2Store) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = request.method;

  const localWorker = /^\/__localflare\/workers\/([^/]+)(\/.*)?$/.exec(pathname);
  if (localWorker) {
    await dispatchWorker(request, response, workers, zones, rulesets, localWorker[1]!, `${localWorker[2] ?? "/"}${url.search}`);
    return;
  }

  if (!pathname.startsWith("/client/v4")) {
    await handleS3(request, response, url, r2);
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

  const rulesetPath = /^\/client\/v4\/zones\/([^/]+)\/rulesets(?:\/([^/]+))?$/.exec(pathname);
  if (rulesetPath) {
    const zoneId = rulesetPath[1]!;
    if (!zones.get(zoneId)) {
      reply(response, 404, null, { code: 9109, message: "Zone not found" });
      return;
    }
    const id = rulesetPath[2];
    if (!id) {
      if (method === "GET") reply(response, 200, rulesets.list(zoneId));
      else if (method === "POST") reply(response, 200, rulesets.create(zoneId, await readJson(request)));
      else reply(response, 404, null);
      return;
    }
    const existing = rulesets.get(zoneId, id);
    if (!existing) {
      reply(response, 404, null, { code: 10021, message: "Ruleset not found" });
      return;
    }
    if (method === "GET") reply(response, 200, existing);
    else if (method === "PUT") reply(response, 200, rulesets.update(zoneId, id, await readJson(request)));
    else if (method === "DELETE") { rulesets.delete(zoneId, id); reply(response, 200, null); }
    else reply(response, 404, null);
    return;
  }

  const dnsPath = /^\/client\/v4\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(pathname);
  if (dnsPath) {
    const zoneId = dnsPath[1]!;
    const zone = zones.get(zoneId);
    if (!zone) reply(response, 404, null, { code: 9109, message: "Zone not found" });
    else await handleDNS(request, response, dns, zoneId, zone.name, dnsPath[2], url);
    return;
  }

  const purgePath = /^\/client\/v4\/zones\/([^/]+)\/purge_cache$/.exec(pathname);
  if (purgePath) {
    if (!zones.get(purgePath[1]!)) reply(response, 404, null, { code: 9109, message: "Zone not found" });
    else if (method === "POST") reply(response, 200, acknowledgePurge(await readJson(request)));
    else reply(response, 404, null);
    return;
  }

  if (pathname === "/client/v4/zones" || pathname.startsWith("/client/v4/zones/")) {
    if (method === "DELETE") {
      const zoneId = /^\/client\/v4\/zones\/([^/]+)$/.exec(pathname)?.[1];
      if (zoneId) {
        rulesets.deleteZone(zoneId);
        dns.deleteZone(zoneId);
      }
    }
    await handleZones(request, response, zones, url);
    return;
  }

  const accountPath = /^\/client\/v4\/accounts\/([^/]+)\/(.*)$/.exec(pathname);
  if (!accountPath || accountPath[1] !== account.id) {
    reply(response, 404, null);
    return;
  }
  const route = accountPath[2]!;
  if (route.startsWith("storage/kv/")) {
    await handleKV(request, response, kv, route.slice("storage/kv/".length), url);
    return;
  }
  if (route.startsWith("d1/")) {
    await handleD1(request, response, d1, route.slice("d1/".length), url);
    return;
  }
  if (route.startsWith("r2/")) {
    await handleR2(request, response, r2, route.slice("r2/".length), url);
    return;
  }
  if (!route.startsWith("workers/")) {
    reply(response, 404, null);
    return;
  }
  const workerRoute = route.slice("workers/".length);
  if (method === "GET" && workerRoute === "subdomain") {
    reply(response, 200, { subdomain: "localflare" });
    return;
  }
  if (method === "GET" && workerRoute === "scripts") {
    reply(response, 200, workers.list());
    return;
  }
  if (method === "GET" && /^workers\/[^/]+$/.test(workerRoute)) {
    const worker = workers.get(workerRoute.slice("workers/".length));
    if (worker) reply(response, 200, { subdomain: worker.subdomain, previews_base_config: {} });
    else reply(response, 404, null, { code: 10007, message: "Worker not found" });
    return;
  }

  const scriptPath = /^scripts\/([^/]+)(?:\/(.*))?$/.exec(workerRoute);
  const servicePath = /^services\/([^/]+)$/.exec(workerRoute);
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
  const kv = new KVStore();
  const d1 = new D1Store();
  const zones = new ZoneStore(account);
  const rulesets = new RulesetStore();
  const dns = new DNSStore();
  const r2 = new R2Store();
  const workers = new WorkerStore(kv, d1, r2);
  const server = createServer((request, response) => {
    void handle(request, response, workers, kv, d1, zones, rulesets, dns, r2).catch((error: unknown) => {
      if (error instanceof InvalidWorkerUpload || error instanceof InvalidRuleset ||
          error instanceof InvalidDNSRecord || error instanceof InvalidCachePurge) {
        reply(response, 400, null, { code: 10021, message: error.message });
      } else {
        console.error(error);
        reply(response, 500, null, { code: 1000, message: "Internal server error" });
      }
    });
  });
  server.on("close", () => { void Promise.all([workers.dispose(), kv.dispose(), d1.dispose(), r2.dispose()]).catch(console.error); });
  return server;
}
