import { randomUUID } from "node:crypto";

export class InvalidCachePurge extends Error {}

/** Validates the Cloudflare purge request shape. Localflare has no CDN cache to evict. */
export function acknowledgePurge(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidCachePurge("Cache purge body must be an object");
  }
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1) throw new InvalidCachePurge("Cache purge needs exactly one method");
  const key = keys[0];
  if (key === "purge_everything") {
    if (body.purge_everything !== true) throw new InvalidCachePurge("purge_everything must be true");
  } else if (key === "files") {
    if (!Array.isArray(body.files) || body.files.length === 0 || !body.files.every((file) => {
      if (typeof file === "string") return isHttpURL(file);
      if (typeof file !== "object" || file === null || Array.isArray(file)) return false;
      const entry = file as Record<string, unknown>;
      if (typeof entry.url !== "string" || !isHttpURL(entry.url)) return false;
      const headers = entry.headers;
      return headers === undefined || (typeof headers === "object" && headers !== null && !Array.isArray(headers) &&
        Object.values(headers).every((value) => typeof value === "string"));
    })) throw new InvalidCachePurge("files must contain HTTP URLs");
  } else if (key === "tags" || key === "hosts" || key === "prefixes") {
    const values = body[key];
    if (!Array.isArray(values) || values.length === 0 ||
        !values.every((value) => typeof value === "string" && value.length > 0)) {
      throw new InvalidCachePurge(`${key} must be nonempty strings`);
    }
  } else throw new InvalidCachePurge("Unsupported cache purge method");
  return { id: randomUUID().replaceAll("-", "") };
}

function isHttpURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
