import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { R2Store, validBucketName } from "./r2.js";

const namespace = "http://s3.amazonaws.com/doc/2006-03-01/";
const maxObjectBytes = 10 * 1024 * 1024;

class ObjectTooLarge extends Error {}

function escapeXML(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

function xml(response: ServerResponse, status: number, body: string, headers?: Record<string, string>) {
  response.writeHead(status, { "content-type": "application/xml", ...headers });
  response.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function s3Error(response: ServerResponse, status: number, code: string, message: string) {
  xml(response, status, `<Error><Code>${escapeXML(code)}</Code><Message>${escapeXML(message)}</Message><RequestId>${randomUUID()}</RequestId></Error>`);
}

async function bodyBytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxObjectBytes) throw new ObjectTooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function objectHeaders(object: { etag: string; size: number; uploaded: Date; httpMetadata?: { contentType?: string } }) {
  return {
    etag: `"${object.etag}"`,
    "content-length": String(object.size),
    "last-modified": object.uploaded.toUTCString(),
    ...(object.httpMetadata?.contentType ? { "content-type": object.httpMetadata.contentType } : {}),
  };
}

/** Path-style S3 subset on the same port as client/v4; fake SigV4 credentials are accepted. */
export async function handleS3(request: IncomingMessage, response: ServerResponse, url: URL, r2: R2Store) {
  const method = request.method;
  if (url.pathname === "/") {
    if (method !== "GET") return s3Error(response, 405, "MethodNotAllowed", "Unsupported S3 operation");
    const buckets = r2.list().map((bucket) =>
      `<Bucket><Name>${escapeXML(bucket.name)}</Name><CreationDate>${bucket.creation_date}</CreationDate></Bucket>`).join("");
    xml(response, 200, `<ListAllMyBucketsResult xmlns="${namespace}"><Owner><ID>localflare</ID><DisplayName>Localflare</DisplayName></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`);
    return;
  }

  const slash = url.pathname.indexOf("/", 1);
  const name = decodeURIComponent(slash < 0 ? url.pathname.slice(1) : url.pathname.slice(1, slash));
  const key = slash < 0 ? undefined : decodeURIComponent(url.pathname.slice(slash + 1));
  if (!validBucketName(name)) return s3Error(response, 400, "InvalidBucketName", "Invalid bucket name");

  if (key === undefined || key === "") {
    if (method === "PUT") {
      if (r2.has(name)) return s3Error(response, 409, "BucketAlreadyOwnedByYou", "Bucket already exists");
      await r2.create(name);
      response.writeHead(200, { location: `/${name}` });
      response.end();
      return;
    }
    if (!r2.has(name)) return s3Error(response, 404, "NoSuchBucket", "The specified bucket does not exist");
    if (method === "HEAD") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (method === "DELETE") {
      const result = await r2.delete(name);
      if (result === "not-empty") return s3Error(response, 409, "BucketNotEmpty", "The bucket is not empty");
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "GET") {
      if (url.searchParams.has("location")) {
        xml(response, 200, `<LocationConstraint xmlns="${namespace}">auto</LocationConstraint>`);
        return;
      }
      const binding = (await r2.binding(name))!;
      const prefix = url.searchParams.get("prefix") ?? "";
      const maxKeys = Number(url.searchParams.get("max-keys") ?? 1000);
      if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) {
        return s3Error(response, 400, "InvalidArgument", "Invalid max-keys");
      }
      const listed = await binding.list({ prefix, limit: maxKeys,
        cursor: url.searchParams.get("continuation-token") ?? undefined });
      const contents = listed.objects.map((object) =>
        `<Contents><Key>${escapeXML(object.key)}</Key><LastModified>${object.uploaded.toISOString()}</LastModified><ETag>"${object.etag}"</ETag><Size>${object.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("");
      const token = listed.cursor ? `<NextContinuationToken>${escapeXML(listed.cursor)}</NextContinuationToken>` : "";
      xml(response, 200, `<ListBucketResult xmlns="${namespace}"><Name>${escapeXML(name)}</Name><Prefix>${escapeXML(prefix)}</Prefix><MaxKeys>${maxKeys}</MaxKeys><KeyCount>${listed.objects.length}</KeyCount><IsTruncated>${listed.truncated}</IsTruncated>${token}${contents}</ListBucketResult>`);
      return;
    }
    return s3Error(response, 405, "MethodNotAllowed", "Unsupported S3 operation");
  }

  const binding = await r2.binding(name);
  if (!binding) return s3Error(response, 404, "NoSuchBucket", "The specified bucket does not exist");
  if (method === "PUT") {
    let body: Buffer;
    try {
      body = await bodyBytes(request);
    } catch (error) {
      if (error instanceof ObjectTooLarge) return s3Error(response, 413, "EntityTooLarge", "Object exceeds Localflare's 10 MiB request limit");
      throw error;
    }
    const contentType = request.headers["content-type"];
    const object = await binding.put(key, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
      httpMetadata: typeof contentType === "string" ? { contentType } : undefined,
    });
    const etag = object?.etag ?? createHash("md5").update(body).digest("hex");
    response.writeHead(200, { etag: `"${etag}"` });
    response.end();
    return;
  }
  if (method === "DELETE") {
    await binding.delete(key);
    response.writeHead(204);
    response.end();
    return;
  }
  if (method === "HEAD") {
    const object = await binding.head(key);
    if (!object) return s3Error(response, 404, "NoSuchKey", "The specified key does not exist");
    response.writeHead(200, objectHeaders(object));
    response.end();
    return;
  }
  if (method === "GET") {
    const object = await binding.get(key);
    if (!object) return s3Error(response, 404, "NoSuchKey", "The specified key does not exist");
    response.writeHead(200, objectHeaders(object));
    response.end(Buffer.from(await object.arrayBuffer()));
    return;
  }
  return s3Error(response, 405, "MethodNotAllowed", "Unsupported S3 operation");
}
