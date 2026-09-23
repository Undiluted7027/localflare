import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

interface Bucket {
  name: string;
  namespace: string;
  creation_date: string;
  jurisdiction: "default";
  location: "enam";
  storage_class: "Standard";
  runtime: Miniflare;
}

export interface R2ObjectMeta {
  key: string;
  etag: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

export interface R2Binding {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<R2ObjectMeta | null>;
  get(key: string): Promise<(R2ObjectMeta & { arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  head(key: string): Promise<R2ObjectMeta | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: R2ObjectMeta[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export function validBucketName(name: string) {
  return name.length >= 3 && name.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(name);
}

function publicBucket(bucket: Bucket) {
  const { name, creation_date, jurisdiction, location, storage_class } = bucket;
  return { name, creation_date, jurisdiction, location, storage_class };
}

/** Bucket identities map to Miniflare R2 namespaces shared with Worker bindings. */
export class R2Store {
  readonly persistPath = mkdtempSync(join(tmpdir(), "localflare-r2-"));
  private readonly buckets = new Map<string, Bucket>();

  list() {
    return [...this.buckets.values()].map(publicBucket).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string) {
    const bucket = this.buckets.get(name);
    return bucket && publicBucket(bucket);
  }

  has(name: string) {
    return this.buckets.has(name);
  }

  namespace(name: string) {
    return this.buckets.get(name)?.namespace;
  }

  async create(name: string) {
    if (!validBucketName(name) || this.has(name)) return undefined;
    const namespace = randomUUID().replaceAll("-", "");
    const runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('') } }",
      r2Buckets: { R2: namespace },
      r2Persist: this.persistPath,
      cf: false,
    });
    try {
      await runtime.ready;
      await runtime.getR2Bucket("R2");
    } catch (error) {
      await runtime.dispose().catch(() => {});
      throw error;
    }
    const bucket: Bucket = {
      name, namespace, creation_date: new Date().toISOString(), jurisdiction: "default",
      location: "enam", storage_class: "Standard", runtime,
    };
    this.buckets.set(name, bucket);
    return publicBucket(bucket);
  }

  async binding(name: string) {
    const bucket = this.buckets.get(name);
    // Miniflare's conditional replacement type misidentifies R2Bucket as Request.
    return bucket && await bucket.runtime.getR2Bucket("R2") as unknown as R2Binding;
  }

  async delete(name: string) {
    const bucket = this.buckets.get(name);
    if (!bucket) return "missing" as const;
    const binding = await this.binding(name);
    if (!binding) throw new Error("R2 bucket binding disappeared");
    if ((await binding.list({ limit: 1 })).objects.length > 0) return "not-empty" as const;
    this.buckets.delete(name);
    await bucket.runtime.dispose();
    return "deleted" as const;
  }

  async dispose() {
    await Promise.all([...this.buckets.values()].map((bucket) => bucket.runtime.dispose()));
    this.buckets.clear();
    await rm(this.persistPath, { recursive: true, force: true });
  }
}
